//! Port of test/strip.test.ts.

use salt::strip::strip;

#[test]
fn keeps_plain_prose() {
    assert_eq!(strip("this is a damn mess").as_deref(), Some("this is a damn mess"));
}

#[test]
fn drops_pure_injected_turns() {
    assert_eq!(strip("<system-reminder>be nice</system-reminder>"), None);
    assert_eq!(
        strip("<command-message>catppuccin-neu</command-message>\n<command-name>/catppuccin-neu</command-name>"),
        None
    );
}

#[test]
fn keeps_prose_around_injected_blocks() {
    let got = strip("fix this <system-reminder>ignore</system-reminder> properly");
    assert_eq!(got.as_deref(), Some("fix this properly"));
}

#[test]
fn unwraps_nothing_from_codex_delegation() {
    let raw = "<codex_delegation>\n  <input>do the thing</input>\n</codex_delegation>";
    assert_eq!(strip(raw), None);
}

#[test]
fn strips_fenced_code() {
    let raw = "look at this\n```rust\nassert!(x);\nclass Foo;\n```\nit is broken";
    let got = strip(raw).expect("prose survives");
    assert!(!got.contains("assert"), "got: {got}");
    assert!(!got.contains("class"), "got: {got}");
    assert!(got.contains("broken"), "got: {got}");
}

#[test]
fn strips_unterminated_fence() {
    assert_eq!(strip("why\n```\nassert!(x);").as_deref(), Some("why"));
}

#[test]
fn strips_inline_code() {
    let got = strip("the `assert_eq!` macro is trash").expect("prose survives");
    assert!(!got.contains("assert"), "got: {got}");
    assert!(got.contains("trash"), "got: {got}");
}

#[test]
fn strips_paths() {
    let got = strip("check /Users/me/src/assets and ~/.config/hell now").expect("prose survives");
    assert!(!got.contains("assets"), "got: {got}");
    assert!(!got.contains("hell"), "got: {got}");
    assert!(got.contains("check"), "got: {got}");
}

#[test]
fn drops_codex_approval_transcript_whole() {
    let raw = "The following is the Codex agent history whose request action you are \
               assessing.\n>>> TRANSCRIPT START\n[1] user: this is fucking broken\n";
    assert_eq!(strip(raw), None);
}

#[test]
fn drops_replayed_request_wrapper() {
    assert_eq!(strip("## My request for Codex: rebase on master"), None);
}

#[test]
fn whitespace_is_the_unicode_class_not_js_backslash_s() {
    // U+FEFF is not a separator: the fused token reads as one path and drops.
    assert_eq!(strip("damn\u{FEFF}a/b/c"), None);
    assert_eq!(strip("foo/x\u{FEFF}y/bar"), None);
    // U+0085 NEL is a separator: only the path token drops…
    assert_eq!(strip("a\u{85}b/c/d").as_deref(), Some("a"));
    // …and it trims away entirely.
    assert_eq!(strip("\u{85}"), None);
}

#[test]
fn path_likeness_measures_utf8_bytes() {
    // "/é" is 2 UTF-16 units but 3 bytes, so it is path-like as in v1.
    assert_eq!(strip("see /é ok").as_deref(), Some("see ok"));
}

#[test]
fn tag_prefix_does_not_overmatch() {
    // `<user_information>` is not `<user_info>`; its text should survive.
    let got = strip("<user_information>keep this</user_information>").expect("prose survives");
    assert!(got.contains("keep this"), "got: {got}");
}
