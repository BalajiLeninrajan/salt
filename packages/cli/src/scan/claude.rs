//! Claude Code session parser.
//!
//! Sessions live at `~/.claude/projects/<slug>/<session-uuid>.jsonl`, one JSON
//! object per line. The overwhelming majority of `type: "user"` lines are tool
//! results, not human turns. `type: "assistant"` lines carry the agent's side;
//! their content mixes `thinking`, `tool_use`, and `text` blocks, and only
//! `text` counts: it is what the agent actually said, as opposed to what it
//! thought or ran.

use std::path::Path;

use serde::Deserialize;

use crate::strip::strip;
use crate::types::{Harness, Message, Role, TsPrecision};

/// Legacy sessions predate the `origin` field; these prefixes mark the
/// machine-generated turns we would otherwise have to guess at.
const LEGACY_REJECT_PREFIXES: [&str; 5] = [
    "<command-message>",
    "<command-name>",
    "<local-command-",
    "<task-notification>",
    "<system-reminder>",
];

/// One mistyped field rejects the whole line: `#[serde(default)]` covers a
/// missing field, but a field that is present with the wrong type fails the
/// whole record. Coercing per-field instead would keep lines the original
/// dropped and shift every downstream count.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    message: Option<Body>,
    #[serde(default)]
    origin: Option<Origin>,
    #[serde(default)]
    is_sidechain: bool,
    #[serde(default)]
    is_meta: bool,
    #[serde(default)]
    is_compact_summary: bool,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct Body {
    #[serde(default)]
    content: Option<Content>,
}

#[derive(Deserialize)]
struct Origin {
    #[serde(default)]
    kind: String,
}

/// `Text(String) | Blocks(Vec<Block>)`; a missing or null `content` is the
/// absent case and is carried as `Option<Content>` by the field itself.
#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

#[derive(Deserialize)]
struct Block {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

pub fn parse_line(line: &str) -> Option<Message> {
    let parsed: Line = serde_json::from_str(line).ok()?;
    // Sidechains are sub-agent traffic: their "user" turns are written by the
    // main agent, and their replies never reach the person at the keyboard.
    // Excluding both sides keeps the user and agent counts comparable.
    if parsed.is_sidechain || parsed.is_meta || parsed.is_compact_summary {
        return None;
    }

    match parsed.kind.as_str() {
        "user" => parse_user(&parsed),
        "assistant" => parse_assistant(&parsed),
        _ => None,
    }
}

fn parse_assistant(parsed: &Line) -> Option<Message> {
    // Only `text` blocks. `thinking` is the agent talking to itself and
    // `tool_use` is machinery, neither of which is the agent's reply.
    let content = parsed.message.as_ref()?.content.as_ref()?;
    let Content::Blocks(blocks) = content else {
        return None;
    };
    finish(&join_text_blocks(blocks), Role::Agent, parsed)
}

fn parse_user(parsed: &Line) -> Option<Message> {
    let content = parsed.message.as_ref()?.content.as_ref();

    let raw = match &parsed.origin {
        // Modern sessions: `origin.kind` is the authorship field, and it is the
        // whole test. `promptSource` records the transport the prompt arrived on
        // (`typed`, `queued`, `sdk`) and says nothing about who wrote it — the
        // desktop app stamps `sdk` on human turns and task notifications alike.
        // Gating on it dropped every desktop session.
        Some(origin) => {
            if origin.kind != "human" {
                return None;
            }
            content_text(content?)?
        }
        // Legacy sessions: string content only. Array content without an
        // `origin` is always a tool result.
        None => match content {
            Some(Content::Text(s)) => {
                let t = s.trim_start();
                if LEGACY_REJECT_PREFIXES.iter().any(|p| t.starts_with(p)) {
                    return None;
                }
                s.clone()
            }
            _ => return None,
        },
    };

    finish(&raw, Role::User, parsed)
}

/// Strips ambient text and timestamps a message. Returns `None` when nothing
/// survives stripping, which is how turns that were purely code or injected
/// context drop out.
fn finish(raw: &str, role: Role, parsed: &Line) -> Option<Message> {
    let text = strip(raw)?;
    let ts = parsed.timestamp.as_deref().and_then(parse_ts)?;

    Some(Message {
        harness: Harness::Claude,
        role,
        ts,
        ts_precision: TsPrecision::Exact,
        cwd: parsed.cwd.clone(),
        session_id: parsed.session_id.clone().unwrap_or_default(),
        text,
    })
}

/// Claude stamps every line with an RFC-3339 instant in UTC; anything else is
/// treated as unparseable and drops the line, as an unparseable date did.
fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// Human turns can carry attachments, so content may be an array even when
/// typed. Concatenate the text blocks and ignore images.
fn content_text(content: &Content) -> Option<String> {
    match content {
        Content::Text(s) => Some(s.clone()),
        Content::Blocks(blocks) => {
            let joined = join_text_blocks(blocks);
            if joined.trim().is_empty() {
                None
            } else {
                Some(joined)
            }
        }
    }
}

/// Joins the `text` blocks the way both v1 parsers did.
fn join_text_blocks(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn parse_file(path: &Path) -> anyhow::Result<Vec<Message>> {
    // A file that will not open is a scan failure; a line that is not valid
    // UTF-8 only costs that line.
    let bytes = std::fs::read(path)?;
    // A byte-order mark belongs to the file, not to its first line. Left in
    // place it makes that line unparseable, and for a rollout the first line is
    // the `session_meta` that carries cwd and session id for everything after
    // it — so one stray BOM would cost the whole session's identity.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let mut out = Vec::new();
    for chunk in bytes.split(|&b| b == b'\n') {
        // Trailing CR is trimmed as bytes rather than on the decoded string:
        // it is ASCII, so this cannot split a code point.
        let line = match chunk.strip_suffix(b"\r") {
            Some(l) => l,
            None => chunk,
        };
        if line.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        if let Some(m) = parse_line(line) {
            out.push(m);
        }
    }
    Ok(out)
}
