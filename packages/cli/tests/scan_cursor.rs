//! Port of `test/scan-cursor.test.ts`.

use rusqlite::Connection;
use salt::scan::cursor::parse_db;
use salt::types::{Harness, Message, Role, TsPrecision};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const META: &str = r#"{"createdAtMs":1784571101149,"updatedAtMs":1784571882088,"cwd":"/tmp/proj"}"#;

const USER_QUERY: &str = r#"{"role":"user","content":[{"type":"text","text":"<user_query>\nthis is broken\n</user_query>"}]}"#;
const USER_INFO: &str = r#"{"role":"user","content":"<user_info>\nOS Version: darwin\n\nWorkspace Path: /tmp/from-info\n</user_info>"}"#;
const ASSISTANT: &str = r#"{"role":"assistant","content":[{"type":"text","text":"damn ok"}]}"#;
const PROTOBUF: &[u8] = &[0x0a, 0xca, 0x01, 0x72, 0x69, 0x67, 0x68, 0x74];

fn chat_dir(dir: &Path) -> PathBuf {
    let chat = dir.join("chat-1");
    fs::create_dir_all(&chat).expect("create chat dir");
    chat
}

fn db_with(blobs: &[&[u8]], meta: &str) -> TempDir {
    let dir = TempDir::new().expect("temp dir");
    let chat = chat_dir(dir.path());
    fs::write(chat.join("meta.json"), meta).expect("write meta");

    let conn = Connection::open(chat.join("store.db")).expect("open db");
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
        .expect("create table");
    for (i, b) in blobs.iter().enumerate() {
        conn.execute(
            "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
            rusqlite::params![i.to_string(), b],
        )
        .expect("insert blob");
    }
    conn.close().expect("close db");
    dir
}

fn parse(dir: &TempDir) -> Vec<Message> {
    parse_db(&dir.path().join("chat-1/store.db")).expect("parse")
}

#[test]
fn extracts_only_the_wrapped_query() {
    // The ambient `<user_info>` blob and the protobuf blob both drop out; the
    // assistant blob survives as the agent's side.
    let dir = db_with(
        &[
            USER_QUERY.as_bytes(),
            USER_INFO.as_bytes(),
            ASSISTANT.as_bytes(),
            PROTOBUF,
        ],
        META,
    );
    let got = parse(&dir);
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].role, Role::User);
    assert_eq!(got[0].text, "this is broken");
    assert_eq!(got[0].harness, Harness::Cursor);
    assert_eq!(got[1].role, Role::Agent);
}

#[test]
fn marks_timestamps_as_session_precision() {
    let dir = db_with(&[USER_QUERY.as_bytes()], META);
    assert!(matches!(parse(&dir)[0].ts_precision, TsPrecision::Session));
}

#[test]
fn prefers_meta_json_cwd() {
    let dir = db_with(&[USER_QUERY.as_bytes()], META);
    assert_eq!(parse(&dir)[0].cwd.as_deref(), Some("/tmp/proj"));
}

#[test]
fn session_id_is_the_chat_dir() {
    let dir = db_with(&[USER_QUERY.as_bytes()], META);
    assert_eq!(parse(&dir)[0].session_id, "chat-1");
}

#[test]
fn ignores_protobuf_blobs_without_error() {
    let dir = db_with(&[PROTOBUF, PROTOBUF], META);
    assert!(parse(&dir).is_empty());
}

#[test]
fn ambient_user_info_alone_yields_nothing() {
    let dir = db_with(&[USER_INFO.as_bytes()], META);
    assert!(parse(&dir).is_empty());
}

#[test]
fn user_info_supplies_cwd_when_meta_has_none() {
    // The `<user_info>` blob is dropped itself, but the workspace path it
    // carries is the fallback cwd for everything after it.
    let dir = db_with(&[USER_INFO.as_bytes(), USER_QUERY.as_bytes()], "{}");
    let got = parse(&dir);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].cwd.as_deref(), Some("/tmp/from-info"));
}

#[test]
fn messages_before_the_cwd_is_known_carry_none() {
    let dir = db_with(
        &[
            USER_QUERY.as_bytes(),
            USER_INFO.as_bytes(),
            ASSISTANT.as_bytes(),
        ],
        "{}",
    );
    let got = parse(&dir);
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].cwd, None);
    assert_eq!(got[1].cwd.as_deref(), Some("/tmp/from-info"));
}

#[test]
fn one_bad_element_rejects_the_whole_content_array() {
    // v1's untagged Content enum failed wholesale on a mixed array.
    let blob = r#"{"role":"assistant","content":[{"type":"text","text":"partial survives"},42]}"#;
    let dir = db_with(&[blob.as_bytes()], META);
    assert!(parse(&dir).is_empty());
}

#[test]
fn one_mistyped_field_rejects_the_whole_blob() {
    let blob = r#"{"role":"assistant","content":[{"type":"text","text":"damn ok"}],"extra":1}"#;
    assert_eq!(
        parse(&db_with(&[blob.as_bytes()], META)).len(),
        1,
        "unknown fields are ignored"
    );
    let bad = r#"{"role":7,"content":"damn ok"}"#;
    assert!(parse(&db_with(&[bad.as_bytes()], META)).is_empty());
}

#[test]
fn invalid_utf8_rejects_the_blob() {
    // `serde_json::from_slice` required valid UTF-8; lossy decoding would keep
    // blobs v1 never saw.
    let mut bytes = br#"{"role":"assistant","content":"bad ? utf8"}"#.to_vec();
    let q = bytes.iter().position(|b| *b == b'?').expect("placeholder");
    bytes[q] = 0xff;
    let dir = db_with(&[&bytes], META);
    assert!(parse(&dir).is_empty());
}

#[test]
fn one_bad_meta_field_discards_the_whole_meta() {
    // All-or-nothing like serde: the valid cwd goes down with the bad
    // timestamp, and the time falls back to the file mtime.
    for meta in [
        r#"{"updatedAtMs":"abc","cwd":"/kept"}"#,
        r#"{"updatedAtMs":1.5,"cwd":"/kept"}"#,
    ] {
        let dir = db_with(&[USER_QUERY.as_bytes()], meta);
        let got = parse(&dir);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].cwd, None);
    }
}

#[test]
fn out_of_range_meta_time_falls_back_to_mtime_cwd_survives() {
    // 1e18 ms is a valid i64 but beyond chrono's DateTime range.
    let dir = db_with(
        &[USER_QUERY.as_bytes()],
        r#"{"updatedAtMs":1000000000000000000,"cwd":"/kept"}"#,
    );
    let got = parse(&dir);
    assert_eq!(got[0].cwd.as_deref(), Some("/kept"));
    assert!(got[0].ts < 1_000_000_000_000_000_000);
}

#[test]
fn missing_meta_still_parses() {
    let dir = TempDir::new().expect("temp dir");
    let chat = chat_dir(dir.path());
    let conn = Connection::open(chat.join("store.db")).expect("open db");
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
        .expect("create");
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES ('1', ?1)",
        [USER_QUERY.as_bytes()],
    )
    .expect("insert");
    conn.close().expect("close");
    let got = parse(&dir);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].cwd, None);
}

#[test]
fn a_db_without_a_blobs_table_fails() {
    let dir = TempDir::new().expect("temp dir");
    let chat = chat_dir(dir.path());
    let conn = Connection::open(chat.join("store.db")).expect("open db");
    conn.execute_batch("CREATE TABLE other (id TEXT)")
        .expect("create");
    conn.close().expect("close");
    assert!(parse_db(&chat.join("store.db")).is_err());
    assert!(parse_db(&chat.join("missing.db")).is_err());
}

#[test]
fn uncheckpointed_wal_frames_are_invisible() {
    // v1 opened with immutable=1, which reads only the main db file; rows a
    // live Cursor has not checkpointed yet must not appear.
    let dir = TempDir::new().expect("temp dir");
    let chat = chat_dir(dir.path());
    fs::write(chat.join("meta.json"), META).expect("write meta");

    let conn = Connection::open(chat.join("store.db")).expect("open db");
    conn.execute_batch("PRAGMA journal_mode=WAL;").expect("wal");
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
        .expect("create");
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES ('1', ?1)",
        [USER_QUERY.as_bytes()],
    )
    .expect("insert");
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint");
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES ('2', ?1)",
        [ASSISTANT.as_bytes()],
    )
    .expect("insert");

    let got = parse(&dir);
    conn.close().expect("close db");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].role, Role::User);
}

#[test]
fn keeps_assistant_replies_without_a_wrapper() {
    // Assistant blobs carry no `<user_query>` wrapper. That requirement applies
    // only to the user side, where it separates a typed prompt from the ambient
    // `<user_info>` block.
    let swear = r#"{"role":"assistant","content":[{"type":"text","text":"that was damn close"}]}"#;
    let dir = db_with(&[USER_QUERY.as_bytes(), swear.as_bytes()], META);
    let got = parse(&dir);
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].role, Role::User);
    assert_eq!(got[1].role, Role::Agent);
    assert_eq!(got[1].text, "that was damn close");
}

#[test]
fn other_roles_and_text_rows_are_handled() {
    let system = r#"{"role":"system","content":"damn ok"}"#;
    // A row stored as TEXT rather than BLOB is the same JSON.
    let dir = TempDir::new().expect("temp dir");
    let chat = chat_dir(dir.path());
    fs::write(chat.join("meta.json"), META).expect("write meta");
    let conn = Connection::open(chat.join("store.db")).expect("open db");
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
        .expect("create");
    conn.execute("INSERT INTO blobs (id, data) VALUES ('1', ?1)", [system])
        .expect("insert");
    conn.execute("INSERT INTO blobs (id, data) VALUES ('2', ?1)", [ASSISTANT])
        .expect("insert");
    conn.execute_batch("INSERT INTO blobs (id, data) VALUES ('3', NULL), ('4', 42)")
        .expect("insert");
    conn.close().expect("close");

    let got = parse(&dir);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].text, "damn ok");
}
