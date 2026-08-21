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

/// A short string contained in all three needles, used to find candidate lines
/// without walking the file line by line.
///
/// This is the difference between reading 15 GB and *decoding* 15 GB. Splitting
/// every line and UTF-8-validating it costs more than the matching does when
/// ~98% of lines are discarded immediately; seeking a two-byte probe with SIMD
/// and only reconstructing the lines that hit skips that work entirely.
const PROBE: &[u8] = b"_m";

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

    let finder = memchr::memmem::Finder::new(PROBE);
    let mut pos = 0usize;
    while pos < bytes.len() {
        let Some(offset) = finder.find(&bytes[pos..]) else {
            break;
        };
        let hit = pos + offset;

        // Reconstruct just this line. `memrchr` stops at the preceding newline
        // rather than rescanning the file, so this stays linear overall.
        let start = memchr::memrchr(b'\n', &bytes[..hit]).map_or(0, |i| i + 1);
        let end = memchr::memchr(b'\n', &bytes[hit..]).map_or(bytes.len(), |i| hit + i);
        // Advance past the whole line so a line with several probe hits is
        // considered once.
        pos = end + 1;

        let mut line = &bytes[start..end];
        while line.last().is_some_and(|b| *b == b'\r' || *b == b'\n') {
            line = &line[..line.len() - 1];
        }
        // The probe is a superset filter; the needles are the real test.
        if !NEEDLES
            .iter()
            .any(|n| memchr::memmem::find(line, n).is_some())
        {
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
