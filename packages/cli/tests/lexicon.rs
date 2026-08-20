//! Ported from the TypeScript `test/lexicon.test.ts`, plus the shape-rejection
//! cases that `src/scan/serde.ts` hand-rolled and serde now enforces.

use salt::lexicon::load_overrides;
use salt::types::Tier;

fn lexicon_file(dir: &tempfile::TempDir, body: &str) -> String {
    let p = dir.path().join("lexicon.toml");
    std::fs::write(&p, body).unwrap();
    p.to_str().unwrap().to_string()
}

fn load(body: &str) -> anyhow::Result<salt::matcher::Overrides> {
    let dir = tempfile::tempdir().unwrap();
    let p = lexicon_file(&dir, body);
    load_overrides(Some(&p))
}

#[test]
fn parses_all_sections() {
    let o = load(
        r#"
        remove = ["hell"]
        allow = ["cassowary"]
        [add]
        blast = "mild"
        "#,
    )
    .unwrap();
    assert_eq!(o.remove, ["hell"]);
    assert_eq!(o.allow, ["cassowary"]);
    assert_eq!(o.add, [("blast".to_string(), Tier::Mild)]);
}

#[test]
fn ignores_unknown_tiers() {
    let o = load("[add]\nblast = \"spicy\"").unwrap();
    assert!(o.add.is_empty());
}

#[test]
fn tier_trim_is_unicode_whitespace() {
    // U+0085 NEL is whitespace to Rust's trim, so the entry is accepted…
    let o = load("[add]\nblast = \"\\u0085mild\"").unwrap();
    assert_eq!(o.add, [("blast".to_string(), Tier::Mild)]);
    // …while U+FEFF is not, so this one is silently dropped.
    let o = load("[add]\nblast = \"\\uFEFFmild\"").unwrap();
    assert!(o.add.is_empty());
}

#[test]
fn tier_matching_is_ascii_case_insensitive() {
    let o = load("[add]\nblast = \"  STRONG  \"").unwrap();
    assert_eq!(o.add, [("blast".to_string(), Tier::Strong)]);
}

#[test]
fn added_words_are_lowercased_but_not_trimmed() {
    let o = load("[add]\n\" BLAST \" = \"mild\"").unwrap();
    assert_eq!(o.add, [(" blast ".to_string(), Tier::Mild)]);
}

#[test]
fn missing_sections_default_to_empty() {
    let o = load("remove = [\"hell\"]").unwrap();
    assert!(o.add.is_empty());
    assert!(o.allow.is_empty());
    assert_eq!(o.remove, ["hell"]);
}

#[test]
fn unknown_top_level_keys_are_ignored() {
    let o = load("nonsense = 3\nremove = [\"hell\"]").unwrap();
    assert_eq!(o.remove, ["hell"]);
}

#[test]
fn one_non_string_tier_rejects_the_whole_file() {
    let err = load("[add]\nblast = \"mild\"\nboom = 3").unwrap_err().to_string();
    assert!(err.starts_with("could not parse lexicon at"), "{err}");
}

#[test]
fn wrong_typed_sections_are_rejected() {
    for body in [
        "add = [\"blast\"]",
        "remove = \"hell\"",
        "remove = [1]",
        "allow = 3",
        "allow = [\"ok\", false]",
    ] {
        let err = load(body).unwrap_err().to_string();
        assert!(err.starts_with("could not parse lexicon at"), "{body}: {err}");
    }
}

#[test]
fn malformed_toml_is_a_parse_error() {
    let err = load("remove = [").unwrap_err().to_string();
    assert!(err.starts_with("could not parse lexicon at"), "{err}");
}

#[test]
fn missing_default_file_is_not_an_error() {
    // Like the v1 test, this consults the real default path: absent or valid
    // is ok, and only a malformed ~/.config/salt/lexicon.toml would fail.
    assert!(load_overrides(None).is_ok());
}

#[test]
fn missing_explicit_file_is_an_error() {
    let err = load_overrides(Some("/nonexistent/lexicon.toml"))
        .unwrap_err()
        .to_string();
    assert_eq!(err, "could not read lexicon at /nonexistent/lexicon.toml");
}

#[test]
fn unreadable_file_is_a_read_error() {
    // A directory in place of the file: readable path, unreadable content.
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().to_str().unwrap();
    let err = load_overrides(Some(p)).unwrap_err().to_string();
    assert_eq!(err, format!("could not read lexicon at {p}"));
}
