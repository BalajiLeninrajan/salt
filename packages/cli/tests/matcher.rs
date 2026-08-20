//! Ported from the TypeScript `test/match.test.ts`, plus coverage for the
//! masked-spelling fix that this rewrite introduces.

use salt::matcher::{Matcher, Overrides};
use salt::types::Tier;

fn words(text: &str) -> Vec<String> {
    Matcher::new(&Overrides::default())
        .find(text)
        .into_iter()
        .map(|h| h.word)
        .collect()
}

fn tier_of(text: &str) -> Tier {
    Matcher::new(&Overrides::default()).find(text)[0].tier
}

#[test]
fn finds_plain_swears() {
    assert_eq!(words("this is fucking broken"), ["fucking"]);
    assert_eq!(words("what the hell"), ["hell"]);
}

#[test]
fn is_case_insensitive() {
    assert_eq!(words("WHAT THE FUCK"), ["fuck"]);
}

#[test]
fn handles_leetspeak() {
    assert_eq!(words("sh1t"), ["shit"]);
    assert_eq!(words("this is BULLSH!T"), ["bullshit"]);
}

#[test]
fn matches_inflections() {
    assert_eq!(words("shitty code"), ["shit"]);
    assert_eq!(words("fucked it up"), ["fucked"]);
    assert_eq!(words("damned thing"), ["damn"]);
}

#[test]
fn assigns_tiers() {
    assert_eq!(tier_of("damn"), Tier::Mild);
    assert_eq!(tier_of("shit"), Tier::Medium);
    assert_eq!(tier_of("fuck"), Tier::Strong);
    assert_eq!(tier_of("wtf"), Tier::Acronym);
}

/// The Scunthorpe problem. These appear constantly in real prompts and a
/// single false positive here destroys trust in the whole report.
#[test]
fn does_not_match_innocent_technical_words() {
    for w in [
        "assert", "assert_eq", "assertion", "assign", "assignment", "asset", "assets", "class",
        "classes", "pass", "passed", "password", "bypass", "bass", "massive", "hello", "shell",
        "analysis", "cassandra", "canvas", "assume", "access", "assistant", "async", "harassment",
        "scunthorpe", "dickinson", "sussex", "oxymoron", "dumbbell", "dumbbells", "dumbo",
    ] {
        assert_eq!(words(w), Vec::<String>::new(), "{w} should not match");
    }
}

#[test]
fn counts_every_occurrence() {
    assert_eq!(words("fuck this fucking shit"), ["fuck", "fucking", "shit"]);
}

#[test]
fn non_ascii_does_not_break_matching() {
    // A multi-byte character between two swears must not split a boundary or
    // panic on a byte index.
    assert_eq!(words("fuckéfuck"), ["fuck", "fuck"]);
}

// --- masked spellings: the behaviour this rewrite changes -------------------

/// The old fold mapped `*` and `#` to `u`, so `f*ck` worked by luck and
/// `sh*t` became `shut` and vanished.
#[test]
fn masked_vowels_match_their_canonical_word() {
    assert_eq!(words("f*ck this"), ["fuck"]);
    assert_eq!(words("sh*t"), ["shit"]);
    assert_eq!(words("f#ck"), ["fuck"]);
    assert_eq!(words("what a b*tch"), ["bitch"]);
    // `d*ck` used to normalise to `duck`, which is not in the lexicon.
    assert_eq!(words("d*ck"), ["dick"]);
    assert_eq!(words("d*mn"), ["damn"]);
    assert_eq!(words("cr*p"), ["crap"]);
}

/// `top_words` is keyed on `Hit::word`, so a masked spelling must report the
/// canonical word or the word list fragments into two entries.
#[test]
fn masked_spellings_report_the_canonical_word() {
    let m = Matcher::new(&Overrides::default());
    let hits = m.find("fuck f*ck f#ck");
    assert_eq!(hits.len(), 3);
    assert!(hits.iter().all(|h| h.word == "fuck"));
    assert!(hits.iter().all(|h| h.tier == Tier::Strong));
}

#[test]
fn masked_spellings_still_honour_word_boundaries() {
    // Inflection after a masked spelling still counts.
    assert_eq!(words("sh*tty code"), ["shit"]);
    // Glued to unrelated letters, it does not.
    assert_eq!(words("sh*tzu"), Vec::<String>::new());
}

/// Markdown emphasis used to be folded into `u`s, which put letters into the
/// matched text that the author never wrote.
#[test]
fn markdown_emphasis_is_not_folded_into_letters() {
    assert_eq!(words("**bold** and *italic*"), Vec::<String>::new());
}

#[test]
fn multi_character_masking_is_out_of_scope() {
    // Documented limitation: `f**k` needs true wildcard matching.
    assert_eq!(words("f**k"), Vec::<String>::new());
}

// --- overrides -------------------------------------------------------------

#[test]
fn remove_drops_a_word() {
    let m = Matcher::new(&Overrides { remove: vec!["damn".into()], ..Default::default() });
    assert!(m.find("damn").is_empty());
}

#[test]
fn allow_suppresses_a_whole_word() {
    let m = Matcher::new(&Overrides { allow: vec!["damn".into()], ..Default::default() });
    assert!(m.find("damn").is_empty());
}

#[test]
fn add_introduces_a_word() {
    let m = Matcher::new(&Overrides {
        add: vec![("blast".into(), Tier::Mild)],
        ..Default::default()
    });
    let hits = m.find("what a blast");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].word, "blast");
    assert_eq!(hits[0].tier, Tier::Mild);
}

/// An empty added word would be a zero-width pattern matching at every
/// position; it is dropped rather than allowed to poison the automaton.
#[test]
fn empty_added_word_is_dropped() {
    let m = Matcher::new(&Overrides {
        add: vec![(String::new(), Tier::Mild)],
        ..Default::default()
    });
    assert_eq!(m.find("fuckéfuck").len(), 2);
}

#[test]
fn removing_every_word_matches_nothing() {
    let all: Vec<String> = Matcher::new(&Overrides::default())
        .find("fuck shit damn hell")
        .into_iter()
        .map(|h| h.word)
        .collect();
    assert!(!all.is_empty());
    let m = Matcher::new(&Overrides {
        remove: salt::matcher::lexicon_words(),
        ..Default::default()
    });
    assert!(m.find("fuck shit damn hell wtf").is_empty());
}
