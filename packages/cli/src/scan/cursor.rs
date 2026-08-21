//! Cursor chat parser.
//!
//! Chats live at `~/.cursor/chats/<workspace-hash>/<chat-uuid>/store.db`, a
//! SQLite file whose `blobs` table mixes protobuf records with a plain-JSON
//! mirror of every message. Only the JSON ones are needed, so no protobuf
//! schema is required.
//!
//! Typed prompts are wrapped in `<user_query>`. The ambient `<user_info>` block
//! is also `role: user` but carries no wrapper, which is exactly what
//! distinguishes them.
//!
//! Cursor stores no per-message timestamp, so prompts inherit the chat's time
//! and are marked session-precision.

use crate::db::read_blobs;
use crate::strip::strip;
use crate::types::{Harness, Message, Role, TsPrecision};
use anyhow::Result;
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// A present-but-wrong-typed field rejects the whole blob: every optional field
/// carries `#[serde(default)]`, so only a *missing* field falls back.
#[derive(Deserialize)]
struct Blob {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: Option<Content>,
}

/// `string | Vec<Block>`; absent and null are both `None` on the field. A mixed
/// array matches neither variant and so rejects the blob.
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

#[derive(Deserialize, Default)]
struct Meta {
    #[serde(default, rename = "createdAtMs")]
    created_at_ms: Option<i64>,
    #[serde(default, rename = "updatedAtMs")]
    updated_at_ms: Option<i64>,
    #[serde(default)]
    cwd: Option<String>,
}

pub fn parse_db(path: &Path) -> Result<Vec<Message>> {
    let meta = read_meta(path);
    let ts = session_time(path, &meta);
    let session_id = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let rows = read_blobs(path)?;

    let mut out = Vec::new();
    let mut cwd = meta.cwd;

    for data in rows {
        // Protobuf blobs are the majority; JSON ones start with '{'.
        if data.first() != Some(&b'{') {
            continue;
        }
        // Invalid UTF-8 skips the blob, exactly as `serde_json::from_slice`
        // rejected it; lossy decoding would keep blobs v1 never saw.
        let Ok(text) = std::str::from_utf8(&data) else {
            continue;
        };
        let Ok(blob) = serde_json::from_str::<Blob>(text) else {
            continue;
        };
        let raw = content_text(blob.content.as_ref());

        let (role, body) = if blob.role == "user" {
            if cwd.is_none() {
                cwd = workspace_path_from_user_info(&raw);
            }
            // The `<user_query>` wrapper is what separates a typed prompt from
            // the ambient `<user_info>` block, which is also `role: user`.
            let Some(inner) = extract_user_query(&raw) else {
                continue;
            };
            (Role::User, inner.to_string())
        } else if blob.role == "assistant" {
            (Role::Agent, raw)
        } else {
            continue;
        };

        let Some(stripped) = strip(&body) else {
            continue;
        };
        out.push(Message {
            harness: Harness::Cursor,
            role,
            ts,
            ts_precision: TsPrecision::Session,
            cwd: cwd.clone(),
            session_id: session_id.clone(),
            text: stripped,
        });
    }
    Ok(out)
}

fn content_text(content: Option<&Content>) -> String {
    match content {
        Some(Content::Text(s)) => s.clone(),
        Some(Content::Blocks(blocks)) => blocks
            .iter()
            .filter(|b| b.kind == "text")
            .filter_map(|b| b.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    }
}

/// The `<user_query>` wrapper is the discriminator between a typed prompt and
/// the ambient `<user_info>` block that shares its role.
fn extract_user_query(raw: &str) -> Option<&str> {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let open = raw.find(OPEN)?;
    let start = open + OPEN.len();
    let end = raw[start..].find(CLOSE)?;
    Some(&raw[start..start + end])
}

fn workspace_path_from_user_info(raw: &str) -> Option<String> {
    const KEY: &str = "Workspace Path:";
    let line = raw.split('\n').find(|l| l.trim_start().starts_with(KEY))?;
    let value = line[line.find(KEY)? + KEY.len()..].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn read_meta(db: &Path) -> Meta {
    let Some(path) = db.parent().map(|d| d.join("meta.json")) else {
        return Meta::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return Meta::default();
    };
    // All-or-nothing: one bad field discards the whole Meta, the valid `cwd`
    // next to it included.
    serde_json::from_str::<Meta>(&text).unwrap_or_default()
}

/// Every message in a chat shares one time, and it is never better than
/// session-precise: Cursor records no per-message timestamp.
fn session_time(db: &Path, meta: &Meta) -> i64 {
    if let Some(ms) = meta.updated_at_ms.or(meta.created_at_ms) {
        // A valid i64 can still sit outside chrono's `DateTime` range, and the
        // report formats every ts through chrono; fall back when it would not
        // survive the round trip.
        if chrono::DateTime::from_timestamp_millis(ms).is_some() {
            return ms;
        }
    }
    file_mtime_ms(db).unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    })
}
