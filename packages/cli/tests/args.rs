//! Command-line parsing.
//!
//! These pin the strings and the shape, not just the happy path: a usage
//! problem is reported bare on stderr and exits 2, and everything else exits 1.
//! The messages are user-facing, so they are asserted exactly.

use salt::args::{parse, resolve_harnesses};
use salt::types::Harness;

fn args(argv: &[&str]) -> Result<salt::args::Args, String> {
    parse(&argv.iter().map(|s| (*s).to_string()).collect::<Vec<_>>()).map_err(|e| e.0)
}

#[test]
fn no_arguments_is_the_default_run() {
    let a = args(&[]).expect("empty argv parses");
    assert_eq!(a, Default::default());
}

#[test]
fn boolean_flags_set_exactly_their_own_field() {
    assert!(args(&["--json"]).unwrap().json);
    assert!(args(&["--no-open"]).unwrap().no_open);
    assert!(args(&["--help"]).unwrap().help);
    assert!(args(&["--version"]).unwrap().version);

    // The parser used to match flag names twice — once by arity, once to pick
    // the field — with a fallthrough arm. That shape lets a new flag silently
    // land on the wrong field, so check each one sets only itself.
    let a = args(&["--help"]).unwrap();
    assert!(a.help && !a.version && !a.json && !a.no_open);
    let v = args(&["--version"]).unwrap();
    assert!(v.version && !v.help && !v.json && !v.no_open);
}

#[test]
fn value_flags_accept_both_spellings() {
    assert_eq!(
        args(&["--since", "30d"]).unwrap().since.as_deref(),
        Some("30d")
    );
    assert_eq!(
        args(&["--since=30d"]).unwrap().since.as_deref(),
        Some("30d")
    );
    assert_eq!(
        args(&["--lexicon", "/tmp/l.toml"])
            .unwrap()
            .lexicon
            .as_deref(),
        Some("/tmp/l.toml")
    );
    assert_eq!(
        args(&["--lexicon=/tmp/l.toml"]).unwrap().lexicon.as_deref(),
        Some("/tmp/l.toml")
    );
}

#[test]
fn harness_is_repeatable_and_comma_separated() {
    let comma = args(&["--harness", "claude,codex"]).unwrap();
    assert_eq!(
        resolve_harnesses(&comma.harness_tokens).unwrap(),
        [Harness::Claude, Harness::Codex]
    );

    let repeated = args(&["--harness", "claude", "--harness", "cursor"]).unwrap();
    assert_eq!(
        resolve_harnesses(&repeated.harness_tokens).unwrap(),
        [Harness::Claude, Harness::Cursor]
    );

    // Names are trimmed and case-folded.
    let messy = args(&["--harness", " Claude , CODEX "]).unwrap();
    assert_eq!(
        resolve_harnesses(&messy.harness_tokens).unwrap(),
        [Harness::Claude, Harness::Codex]
    );
}

#[test]
fn unknown_and_misused_flags_are_usage_errors() {
    assert_eq!(args(&["--bogus"]).unwrap_err(), "Unknown option '--bogus'");
    // A short flag is a mistyped option, not a positional — saying so is more
    // use than telling someone this command takes no positional arguments.
    assert_eq!(args(&["-j"]).unwrap_err(), "Unknown option '-j'");
    assert_eq!(
        args(&["extra"]).unwrap_err(),
        "Unexpected argument 'extra'. This command does not take positional arguments"
    );
    assert_eq!(
        args(&["--json=yes"]).unwrap_err(),
        "Option '--json' does not take an argument"
    );
    assert_eq!(
        args(&["--harness"]).unwrap_err(),
        "Option '--harness <value>' argument missing"
    );
    assert_eq!(
        args(&["--since"]).unwrap_err(),
        "Option '--since <value>' argument missing"
    );
    assert_eq!(
        args(&["--lexicon"]).unwrap_err(),
        "Option '--lexicon <value>' argument missing"
    );
}

#[test]
fn a_bad_harness_name_is_reported_with_the_name() {
    let a = args(&["--harness", "bogus"]).unwrap();
    assert_eq!(
        resolve_harnesses(&a.harness_tokens).unwrap_err().0,
        "unknown harness: bogus"
    );
}

/// `--help` used to lose to a bad harness name because the parser resolved
/// harnesses eagerly, so `salt --help --harness bogus` exited 2 printing
/// nothing. Parsing now defers the names so help still wins.
#[test]
fn help_survives_an_invalid_harness() {
    let a = args(&["--help", "--harness", "bogus"]).expect("parsing must not fail here");
    assert!(a.help);
    assert!(
        resolve_harnesses(&a.harness_tokens).is_err(),
        "still invalid, just not yet fatal"
    );
}

#[test]
fn a_bare_double_dash_is_accepted() {
    let a = args(&["--", "--json"]).unwrap();
    assert!(a.json, "there are no positionals, so -- separates nothing");
}

#[test]
fn later_values_win_and_flags_compose() {
    let a = args(&["--json", "--no-open", "--since", "7d", "--since", "30d"]).unwrap();
    assert!(a.json && a.no_open);
    assert_eq!(a.since.as_deref(), Some("30d"));
}
