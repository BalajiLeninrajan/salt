use std::io::Write;

use salt::scan::claude::{parse_file, parse_line};
use salt::types::{Harness, Role, TsPrecision};

#[test]
fn keeps_typed_human_turn() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"this is broken"},"timestamp":"2026-08-17T21:33:43.823Z","cwd":"/tmp/x","sessionId":"s1"}"#;
    let m = parse_line(line).expect("kept");
    assert_eq!(m.text, "this is broken");
    assert_eq!(m.session_id, "s1");
    assert_eq!(m.ts_precision, TsPrecision::Exact);
    assert_eq!(m.harness, Harness::Claude);
    assert_eq!(m.cwd.as_deref(), Some("/tmp/x"));
    assert_eq!(m.ts, 1787002423823);
}

#[test]
fn keeps_queued_human_turn() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"queued","message":{"role":"user","content":"why plain js"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_some());
}

#[test]
fn drops_tool_result() {
    let line = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"command not found"}]},"timestamp":"2026-08-17T21:33:49.456Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn drops_task_notification() {
    let line = r#"{"type":"user","origin":{"kind":"task-notification"},"promptSource":"system","message":{"role":"user","content":"<task-notification>done</task-notification>"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

/// The desktop app stamps the `sdk` transport on typed prompts, so it cannot be
/// a filter.
#[test]
fn keeps_sdk_transport() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"sdk","message":{"role":"user","content":"hi"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert_eq!(parse_line(line).unwrap().text, "hi");
}

#[test]
fn drops_non_human_origin_even_on_sdk_transport() {
    let line = r#"{"type":"user","origin":{"kind":"task-notification"},"promptSource":"sdk","message":{"role":"user","content":"done"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn keeps_unknown_transport_when_origin_is_human() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"future-transport","message":{"role":"user","content":"hi"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert_eq!(parse_line(line).unwrap().text, "hi");
}

#[test]
fn drops_sidechain() {
    let line = r#"{"type":"user","isSidechain":true,"origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"sub agent"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn legacy_string_turn_is_kept() {
    let line = r#"{"type":"user","message":{"role":"user","content":"make it work"},"timestamp":"2026-05-17T21:33:43.823Z"}"#;
    let m = parse_line(line).expect("kept");
    assert_eq!(m.text, "make it work");
    assert_eq!(m.session_id, "");
    assert_eq!(m.cwd, None);
}

#[test]
fn legacy_slash_command_is_dropped() {
    let line = r#"{"type":"user","message":{"role":"user","content":"<command-message>catppuccin-neu</command-message>\n<command-name>/catppuccin-neu</command-name>"},"timestamp":"2026-05-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn array_content_human_turn_is_kept() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image","source":{}}]},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert_eq!(parse_line(line).unwrap().text, "look at this");
}

#[test]
fn keeps_assistant_text_block() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"that was damn close"}]},"timestamp":"2026-08-17T21:33:44.000Z","sessionId":"s1"}"#;
    let m = parse_line(line).expect("kept");
    assert_eq!(m.role, Role::Agent);
    assert_eq!(m.text, "that was damn close");
}

#[test]
fn drops_assistant_thinking_and_tool_use() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"this is damn hard","signature":"x"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-08-17T21:33:44.000Z"}"#;
    assert!(parse_line(line).is_none());
}

/// Compaction summaries quote the user's own prompts back verbatim, so counting
/// them would attribute the user's swearing to the agent.
#[test]
fn drops_compact_summary() {
    let line = r#"{"type":"assistant","isCompactSummary":true,"message":{"role":"assistant","content":[{"type":"text","text":"The user said this is fucking broken"}]},"timestamp":"2026-08-17T21:33:44.000Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn drops_sidechain_assistant_turn() {
    let line = r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"damn ok"}]},"timestamp":"2026-08-17T21:33:44.000Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn user_turns_are_tagged_as_user() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"hello there"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert_eq!(parse_line(line).unwrap().role, Role::User);
}

/// v1 deserialized each line into typed structs, so a bad sibling field dropped
/// the line wholesale rather than being coerced around.
#[test]
fn one_mistyped_field_rejects_the_whole_line() {
    let cases = [
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},42]},"timestamp":"2026-08-17T21:33:44.000Z"}"#,
        r#"{"type":"user","isMeta":null,"message":{"role":"user","content":"hello"},"timestamp":"2026-08-17T21:33:43.823Z"}"#,
        r#"{"type":"user","cwd":5,"message":{"role":"user","content":"hello"},"timestamp":"2026-08-17T21:33:43.823Z"}"#,
        r#"{"type":"assistant","origin":"weird","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-17T21:33:44.000Z"}"#,
        r#"{"type":null,"message":{"role":"user","content":"hello"},"timestamp":"2026-08-17T21:33:43.823Z"}"#,
        r#"{"type":"user","message":[],"timestamp":"2026-08-17T21:33:43.823Z"}"#,
        r#"{"type":"user","message":{"content":true},"timestamp":"2026-08-17T21:33:43.823Z"}"#,
        r#"{"type":"user","message":{"content":[{"type":"text","text":5}]},"timestamp":"2026-08-17T21:33:43.823Z"}"#,
        r#"{"type":"user","sessionId":7,"message":{"role":"user","content":"hello"},"timestamp":"2026-08-17T21:33:43.823Z"}"#,
    ];
    for line in cases {
        assert!(parse_line(line).is_none(), "should reject: {line}");
    }
}

/// Missing and null are the absent case, not a type error.
#[test]
fn missing_and_null_optionals_are_absent() {
    let line = r#"{"type":"user","origin":null,"cwd":null,"sessionId":null,"message":{"role":"user","content":"hello there"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    let m = parse_line(line).expect("kept");
    assert_eq!(m.cwd, None);
    assert_eq!(m.session_id, "");
    assert_eq!(m.role, Role::User);
}

#[test]
fn turn_that_is_only_code_is_dropped() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"```\nassert!(x);\n```"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn unknown_type_and_missing_timestamp_are_dropped() {
    let no_type = r#"{"message":{"role":"user","content":"hello there"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(no_type).is_none());

    let system = r#"{"type":"system","message":{"role":"user","content":"hello there"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(system).is_none());

    let no_ts = r#"{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"hello there"}}"#;
    assert!(parse_line(no_ts).is_none());

    let bad_ts = r#"{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"hello there"},"timestamp":"not a date"}"#;
    assert!(parse_line(bad_ts).is_none());
}

#[test]
fn drops_meta_turn() {
    let line = r#"{"type":"user","isMeta":true,"origin":{"kind":"human"},"message":{"role":"user","content":"hello there"},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

/// An `origin` block whose array content holds nothing but attachments trims to
/// empty and is not a turn.
#[test]
fn drops_empty_array_content() {
    let line = r#"{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"image","source":{}}]},"timestamp":"2026-08-17T21:33:43.823Z"}"#;
    assert!(parse_line(line).is_none());
}

#[test]
fn joins_multiple_text_blocks_with_newline() {
    let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first line"},{"type":"thinking","thinking":"x"},{"type":"text","text":"second line"}]},"timestamp":"2026-08-17T21:33:44.000Z"}"#;
    // The blocks are joined with a newline, which `strip` then collapses to a
    // space along with all other whitespace.
    assert_eq!(parse_line(line).unwrap().text, "first line second line");
}

#[test]
fn parse_file_reads_jsonl_and_survives_junk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(br#"{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"first prompt"},"timestamp":"2026-08-17T21:33:43.823Z","sessionId":"s1"}"#).unwrap();
    f.write_all(b"\r\n").unwrap();
    f.write_all(b"\n").unwrap();
    f.write_all(b"not json\n").unwrap();
    // Invalid UTF-8 costs its line, not the file.
    f.write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"\xff\xfe\"}}\n").unwrap();
    f.write_all(br#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"second prompt"}]},"timestamp":"2026-08-17T21:33:44.000Z"}"#).unwrap();
    f.write_all(b"\n").unwrap();
    drop(f);

    let msgs = parse_file(&path).unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].text, "first prompt");
    assert_eq!(msgs[0].role, Role::User);
    assert_eq!(msgs[1].text, "second prompt");
    assert_eq!(msgs[1].role, Role::Agent);
}

#[test]
fn parse_file_errors_when_the_file_cannot_be_opened() {
    let dir = tempfile::tempdir().unwrap();
    assert!(parse_file(&dir.path().join("nope.jsonl")).is_err());
}
