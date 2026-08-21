//! Tiered profanity matching.
//!
//! Accuracy here is what the whole tool rests on. Two failure modes matter, and
//! they pull in opposite directions:
//!
//! * **False positives.** These prompts are saturated with code and technical
//!   English. `assert`, `class`, `pass`, `analysis`, and `Scunthorpe` all embed
//!   swear substrings. Word boundaries plus an explicit allowlist handle this;
//!   the stripper having already removed code does most of the work.
//! * **Evasion.** People write `f*ck`, `sh1t`, `fck`. Normalisation folds those
//!   onto their canonical spelling before matching.

use std::collections::{HashMap, HashSet};

use aho_corasick::{AhoCorasick, MatchKind};

use crate::text::{is_word_byte, whole_word, word_byte_at, word_byte_before};
use crate::types::Tier;

mod tables;

use tables::{ALLOWLIST, LEXICON, SUFFIXES};

/// Stands in for a censor character (`*` or `#`).
///
/// Those two are *masks*, not substitutions: `*` in `f*ck` is a `u` but in
/// `sh*t` it is an `i`. Folding them to one letter — which is what the
/// TypeScript implementation did — makes `f*ck` match and silently loses
/// `sh*t`, because it normalises to `shut`. So the mask keeps its own
/// identity here and the lexicon carries the masked spellings instead.
///
/// U+0001 is used because it is not a word byte and cannot occur in prose.
const MASK: char = '\u{1}';

const VOWELS: &[u8] = b"aeiou";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// The canonical lexicon word, never the matched surface form — this is
    /// what `top_words` is keyed on, so `shit` and `sh*t` must agree.
    pub word: String,
    pub tier: Tier,
}

/// Overrides parsed from the user's lexicon file.
#[derive(Debug, Default, Clone)]
pub struct Overrides {
    pub add: Vec<(String, Tier)>,
    pub remove: Vec<String>,
    pub allow: Vec<String>,
}

/// Folds case, leetspeak, and censor characters onto canonical spellings so
/// `F*ck`, `sh1t`, and `FUCK` all reach the lexicon.
///
/// Only ASCII is rewritten; everything else passes through untouched.
pub fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let c = ch.to_ascii_lowercase();
        out.push(match c {
            // Unambiguous leet substitutions: each has exactly one reading.
            '4' | '@' => 'a',
            '3' => 'e',
            '1' | '!' => 'i',
            '0' => 'o',
            '$' | '5' => 's',
            '7' => 't',
            // Ambiguous masks: handled by the lexicon, not by guessing a letter.
            '*' | '#' => MASK,
            _ => c,
        });
    }
    out
}

/// Every masked spelling of `word`: one vowel replaced by the mask, in turn.
///
/// Single-vowel masking only. `f**k` and `a**` need true wildcard matching and
/// are out of scope; vowels rather than any position because false positives
/// are the failure mode that matters most here.
fn masked_variants(word: &str) -> Vec<String> {
    // A vowel byte is always a whole character: every byte of a multi-byte
    // UTF-8 sequence is >= 0x80, so an index that matches an ASCII vowel can
    // never land inside one. That holds even for a non-ASCII word from the
    // user's lexicon, which is why this can slice around the index directly.
    word.bytes()
        .enumerate()
        .filter(|(_, b)| VOWELS.contains(b))
        .map(|(i, _)| {
            let mut masked = String::with_capacity(word.len());
            masked.push_str(&word[..i]);
            masked.push(MASK);
            masked.push_str(&word[i + 1..]);
            masked
        })
        .collect()
}

/// Every canonical word in the built-in lexicon.
pub fn lexicon_words() -> Vec<String> {
    LEXICON.iter().map(|(w, _)| (*w).to_string()).collect()
}

pub struct Matcher {
    /// `None` when every word was removed; `find` then matches nothing.
    ac: Option<AhoCorasick>,
    /// Pattern id → the canonical word and tier it stands for. Masked variants
    /// point back at their unmasked spelling.
    meta: Vec<(String, Tier)>,
    allow: HashSet<String>,
}

impl Matcher {
    pub fn new(overrides: &Overrides) -> Matcher {
        let removed: HashSet<&str> = overrides.remove.iter().map(String::as_str).collect();

        // First insertion wins, like Aho-Corasick reporting the lowest pattern
        // id for duplicate patterns.
        let mut tiers: Vec<(String, Tier)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for (w, t) in LEXICON {
            if !removed.contains(w) && seen.insert((*w).to_string()) {
                tiers.push(((*w).to_string(), *t));
            }
        }
        for (w, t) in &overrides.add {
            // Removal compares the raw string, before lowercasing.
            if removed.contains(w.as_str()) {
                continue;
            }
            let lower = w.to_ascii_lowercase();
            // An empty added word would be a zero-width pattern matching
            // everywhere; drop it rather than let it poison the automaton.
            if !lower.is_empty() && seen.insert(lower.clone()) {
                tiers.push((lower, *t));
            }
        }

        let mut patterns: Vec<String> = Vec::new();
        let mut meta: Vec<(String, Tier)> = Vec::new();
        let mut pattern_seen: HashSet<String> = HashSet::new();
        for (word, tier) in &tiers {
            for spelling in std::iter::once(word.clone()).chain(masked_variants(word)) {
                if pattern_seen.insert(spelling.clone()) {
                    patterns.push(spelling);
                    meta.push((word.clone(), *tier));
                }
            }
        }

        let ac = if patterns.is_empty() {
            None
        } else {
            Some(
                AhoCorasick::builder()
                    .match_kind(MatchKind::LeftmostLongest)
                    .build(&patterns)
                    .expect("lexicon patterns are literal and finite"),
            )
        };

        let mut allow: HashSet<String> = ALLOWLIST.iter().map(|s| (*s).to_string()).collect();
        allow.extend(overrides.allow.iter().map(|s| s.to_ascii_lowercase()));

        Matcher { ac, meta, allow }
    }

    /// Returns every confirmed swear in `text`.
    pub fn find(&self, text: &str) -> Vec<Hit> {
        let Some(ac) = &self.ac else {
            return Vec::new();
        };
        let normalised = normalise(text);
        let mut hits = Vec::new();

        for m in ac.find_iter(&normalised) {
            let (start, end) = (m.start(), m.end());
            if !is_word_boundary(&normalised, start, end) {
                continue;
            }
            // Reject when the surrounding whole word is an innocent one.
            let (ws, we) = whole_word(&normalised, start, end);
            if self.allow.contains(&normalised[ws..we]) {
                continue;
            }
            let (word, tier) = &self.meta[m.pattern().as_usize()];
            hits.push(Hit {
                word: word.clone(),
                tier: *tier,
            });
        }
        hits
    }

    /// Counts hits by canonical word, for `top_words`.
    pub fn tally(hits: &[Hit], into: &mut HashMap<String, (Tier, u64)>) {
        for h in hits {
            into.entry(h.word.clone())
                .and_modify(|e| e.1 += 1)
                .or_insert((h.tier, 1));
        }
    }
}

/// A match counts only when the lexicon word is not glued to more letters,
/// except for a small set of grammatical suffixes.
fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    if word_byte_before(text, start) {
        return false;
    }
    if !word_byte_at(text, end) {
        return true;
    }
    let tail = &text[end..];
    SUFFIXES.iter().any(|suf| {
        tail.starts_with(suf)
            && (tail.len() == suf.len() || !is_word_byte(tail.as_bytes()[suf.len()]))
    })
}
