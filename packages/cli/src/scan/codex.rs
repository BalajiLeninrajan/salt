//! Codex rollout parser.
//!
//! Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
//! `~/.codex/archived_sessions/`, as a wrapped event log. Human turns arrive as
//! `event_msg` / `user_message`, but Codex also injects synthetic turns through
//! that same channel (`<codex_delegation>`, `<in-app-browser-context>`,
//! `<recommended_plugins>`), so the stripper does the real filtering.
//!
//! The agent's side arrives as `event_msg` / `agent_message`. Both roles are
//! mirrored into `response_item` with extra plumbing; taking the `event_msg`
//! channel for both is what keeps them from being counted twice.

use std::path::Path;

use serde::Deserialize;

use crate::strip::strip;
use crate::types::{Harness, Message, Role, TsPrecision};

/// The gate that decides a line is worth decoding. Every line we care about
/// contains one of these; a sampled rollout held 1,841 `token_count` events
/// against 20 `user_message`.
const NEEDLES: [&[u8]; 3] = [
    b"\"user_message\"",
    b"\"agent_message\"",
    b"\"session_meta\"",
];

/// Prebuilt so the SIMD searcher for each needle is constructed once per
/// process rather than once per line.
static FINDERS: std::sync::LazyLock<[memchr::memmem::Finder<'static>; 3]> =
    std::sync::LazyLock::new(|| NEEDLES.map(memchr::memmem::Finder::new));

/// One mistyped field rejects the whole line: `#[serde(default)]` covers a
/// missing field, but a present one of the wrong type fails the record, and the
/// caller turns that failure into a skipped line.
#[derive(Deserialize)]
struct Line {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    payload: Option<Payload>,
}

#[derive(Deserialize)]
struct Payload {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

/// Parses one rollout. Session metadata comes from the first `session_meta`
/// line; later ones are forks and are ignored so a file maps to one session.
pub fn parse_file(path: &Path) -> anyhow::Result<Vec<Message>> {
    let bytes = std::fs::read(path)?;
    // A byte-order mark belongs to the file, not to its first line. Left in
    // place it makes that line unparseable, and for a rollout the first line is
    // the `session_meta` that carries cwd and session id for everything after
    // it — so one stray BOM would cost the whole session's identity.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let mut cwd: Option<String> = None;
    let mut session_id = String::new();
    let mut seen_meta = false;
    let mut out: Vec<Message> = Vec::new();

    // Newlines are found with `memchr`, not `split(|b| b == b'\n')`. That
    // closure form compares a byte at a time; `memchr` uses the platform's
    // vector instructions and measured 3.0 GB/s against 11.4 GB/s over this
    // corpus. Line-finding, not line-testing, was the cost that mattered:
    // ~91% of lines are discarded, and reaching that verdict quickly is the
    // whole job.
    let mut start = 0usize;
    for nl in memchr::memchr_iter(b'\n', bytes).chain(std::iter::once(bytes.len())) {
        if nl < start {
            continue;
        }
        let mut line = &bytes[start..nl];
        start = nl + 1;
        while line.last().is_some_and(|b| *b == b'\r' || *b == b'\n') {
            line = &line[..line.len() - 1];
        }
        if line.is_empty() {
            continue;
        }
        // A sampled rollout held 1,841 `token_count` events against 20
        // `user_message`, so most lines fail here and cost nothing more.
        if !FINDERS.iter().any(|f| f.find(line).is_some()) {
            continue;
        }
        // Invalid UTF-8 skips the line, not the file.
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Line>(line) else {
            continue;
        };
        let Some(payload) = parsed.payload else {
            continue;
        };

        if parsed.r#type == "session_meta" {
            // A malformed meta line never reaches here, so a later valid one
            // can still win; a valid later one is a fork and is dropped.
            if seen_meta {
                continue;
            }
            seen_meta = true;
            cwd = payload.cwd;
            session_id = payload.session_id.unwrap_or_default();
            continue;
        }

        if parsed.r#type != "event_msg" {
            continue;
        }
        let role = match payload.r#type.as_str() {
            "user_message" => Role::User,
            "agent_message" => Role::Agent,
            _ => continue,
        };
        let Some(message) = payload.message else {
            continue;
        };
        let Some(text) = strip(&message) else {
            continue;
        };
        let Some(ts) = parsed.timestamp.as_deref().and_then(parse_ts) else {
            continue;
        };

        out.push(Message {
            harness: Harness::Codex,
            role,
            ts,
            ts_precision: TsPrecision::Exact,
            cwd: cwd.clone(),
            session_id: session_id.clone(),
            text,
        });
    }

    Ok(out)
}

/// Codex stamps every line RFC 3339; anything else is dropped rather than
/// guessed at, so an unparseable stamp loses the turn instead of dating it.
fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis())
}
