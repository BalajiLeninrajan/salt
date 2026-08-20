//! Ported from the TypeScript `test/scan-codex.test.ts`.

use std::path::PathBuf;

use salt::scan::codex::parse_file;
use salt::types::{Message, Role};

const META: &str = r#"{"timestamp":"2026-08-01T08:14:04.658Z","type":"session_meta","payload":{"session_id":"s1","cwd":"/tmp/proj"}}"#;

/// Each case writes its own rollout; the dir lives as long as the returned
/// guard, which the caller holds until after the parse.
fn parse_str(body: &str) -> (tempfile::TempDir, Vec<Message>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path: PathBuf = dir.path().join("rollout-0.jsonl");
    std::fs::write(&path, body).expect("write");
    let got = parse_file(&path).expect("parse");
    (dir, got)
}

fn parse(body: &str) -> Vec<Message> {
    parse_str(body).1
}

#[test]
fn keeps_real_user_message_and_takes_session_meta() {
    let body = format!(
        "{META}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"this is broken"}}"#
    );
    let got = parse(&body);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].text, "this is broken");
    assert_eq!(got[0].cwd.as_deref(), Some("/tmp/proj"));
    assert_eq!(got[0].session_id, "s1");
}

#[test]
fn drops_delegation_injection() {
    let body = format!(
        "{META}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"<codex_delegation>\n  <input>go</input>\n</codex_delegation>"}}"#
    );
    assert!(parse(&body).is_empty());
}

#[test]
fn drops_ambient_browser_context() {
    let body = format!(
        "{META}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"\n<in-app-browser-context source=\"ambient-ui-state\">\nstuff\n</in-app-browser-context>"}}"#
    );
    assert!(parse(&body).is_empty());
}

#[test]
fn ignores_noise_events() {
    let body = format!(
        "{META}\n{}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
        r#"{"timestamp":"2026-08-01T08:15:01.000Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"damn this is hard"}}"#
    );
    assert!(parse(&body).is_empty());
}

#[test]
fn does_not_double_count_response_item_mirror() {
    let body = format!(
        "{META}\n{}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"fix it"}}"#,
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix it"}]}}"#
    );
    assert_eq!(parse(&body).len(), 1);
}

#[test]
fn keeps_agent_message() {
    let body = format!(
        "{META}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"that was damn close"}}"#
    );
    let got = parse(&body);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].role, Role::Agent);
    assert_eq!(got[0].text, "that was damn close");
}

#[test]
fn tags_each_role_and_ignores_the_assistant_mirror() {
    let body = format!(
        "{META}\n{}\n{}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"fix it"}}"#,
        r#"{"timestamp":"2026-08-01T08:15:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done, damn that was subtle"}}"#,
        r#"{"timestamp":"2026-08-01T08:15:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done, damn that was subtle"}]}}"#
    );
    let got = parse(&body);
    // response_item mirror must not be counted
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].role, Role::User);
    assert_eq!(got[1].role, Role::Agent);
}

#[test]
fn drops_agent_reasoning() {
    let body = format!(
        "{META}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:01.000Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"damn this is hard"}}"#
    );
    assert!(parse(&body).is_empty());
}

#[test]
fn malformed_session_meta_is_skipped_not_consumed() {
    // A mistyped field fails the whole line as serde does, so the next valid
    // session_meta is the one that wins.
    let bads = [
        r#"{"timestamp":"2026-08-01T08:14:04.658Z","type":"session_meta","payload":{"session_id":"first","cwd":123}}"#,
        r#"{"timestamp":123,"type":"session_meta","payload":{"session_id":"first","cwd":"/first"}}"#,
    ];
    for bad in bads {
        let body = format!(
            "{bad}\n{}\n{}\n",
            r#"{"timestamp":"2026-08-01T08:14:05.000Z","type":"session_meta","payload":{"session_id":"second","cwd":"/second"}}"#,
            r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#
        );
        let got = parse(&body);
        assert_eq!(got[0].session_id, "second");
        assert_eq!(got[0].cwd.as_deref(), Some("/second"));
    }
}

#[test]
fn first_session_meta_wins_over_fork() {
    let body = format!(
        "{META}\n{}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:14:05.000Z","type":"session_meta","payload":{"session_id":"s2","cwd":"/tmp/other"}}"#,
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#
    );
    let got = parse(&body);
    assert_eq!(got[0].session_id, "s1");
    assert_eq!(got[0].cwd.as_deref(), Some("/tmp/proj"));
}

// --- Coverage the TS suite leaves to its shared helpers ---

#[test]
fn timestamp_must_parse() {
    let body = format!(
        "{META}\n{}\n{}\n",
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"no stamp here"}}"#,
        r#"{"timestamp":"not a date","type":"event_msg","payload":{"type":"user_message","message":"bad stamp"}}"#
    );
    assert!(parse(&body).is_empty());
}

#[test]
fn timestamp_is_milliseconds_since_epoch() {
    let body = format!(
        "{META}\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.250Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#
    );
    assert_eq!(parse(&body)[0].ts, 1_785_572_100_250);
}

#[test]
fn survives_garbage_lines_and_missing_meta() {
    // No session_meta at all, plus a line that is not JSON but passes the
    // substring gate: neither may abort the file.
    let body = format!(
        "not json at all \"user_message\"\n\n{}\n",
        r#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#
    );
    let got = parse(&body);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].session_id, "");
    assert_eq!(got[0].cwd, None);
}

#[test]
fn invalid_utf8_line_is_skipped_not_the_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("rollout-utf8.jsonl");
    let mut body: Vec<u8> =
        br#"{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"#
            .to_vec();
    body.extend_from_slice(&[b'"', 0xff, b'"', b'}', b'}']);
    body.push(b'\n');
    body.extend_from_slice(
        br#"{"timestamp":"2026-08-01T08:15:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}"#,
    );
    std::fs::write(&path, &body).expect("write");
    let got = parse_file(&path).expect("parse");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].text, "hello there");
}

#[test]
fn missing_file_fails_the_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(parse_file(&dir.path().join("nope.jsonl")).is_err());
}
