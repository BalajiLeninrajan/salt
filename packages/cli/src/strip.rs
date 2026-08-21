//! Removes machine-injected text from a raw turn.
//!
//! Every harness routes synthetic content through the same `role: user` channel
//! that carries real typed prompts: system reminders, slash-command envelopes,
//! delegation payloads, ambient UI state. Matching profanity against that text
//! would count words the user never typed.
//!
//! Code is stripped for the same reason in reverse: prompts are saturated with
//! source, and identifiers like `assert`, `class`, and `bass` are where
//! false-positive swear matches come from.

mod tables;

use tables::{INJECTED_PREAMBLES, INJECTED_TAGS, REJECT_WHOLE};

/// Strips injected blocks and code, returning the human prose that remains, or
/// `None` when nothing survives — that means the turn was entirely
/// machine-generated and is not a human prompt at all.
pub fn strip(input: &str) -> Option<String> {
    if REJECT_WHOLE.iter().any(|m| input.contains(m)) {
        return None;
    }

    let mut text = input.to_string();
    // Each pass below walks the whole string, and the tag pass walks it once
    // per tag. Most turns contain none of the characters that could trigger
    // them, so probing for a single character first skips upwards of twenty
    // full passes over the common message.
    if text.contains('<') {
        for (open_prefix, close) in INJECTED_TAGS {
            text = remove_tag_blocks(&text, open_prefix, close);
        }
    }
    if text.contains("```") || text.contains("~~~") {
        text = remove_fenced_code(&text);
    }
    if text.contains('`') {
        text = remove_inline_code(&text);
    }
    // Always runs: it collapses all whitespace, which is what makes skipping
    // the fence pass (and its line-ending normalisation) unobservable.
    text = remove_paths(&text);

    for preamble in INJECTED_PREAMBLES {
        if let Some(idx) = text.find(preamble) {
            text.truncate(idx);
        }
    }

    let cleaned = text.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// Removes `<tag ...>...</tag>` spans, and self-closing / unclosed `<tag ...>`
/// openers. An unclosed opener swallows the rest of the input, which is the
/// correct reading: truncated injected blocks are still injected.
fn remove_tag_blocks(input: &str, open_prefix: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = input;

    loop {
        let Some(start) = rest.find(open_prefix) else {
            out.push_str(rest);
            return out;
        };
        // Guard against `<user_infoX>` matching the `user_info` prefix.
        let after = start + open_prefix.len();
        let next = rest.as_bytes().get(after).copied();
        if !matches!(next, Some(b'>') | Some(b' ') | Some(b'/')) {
            out.push_str(&rest[..after]);
            rest = &rest[after..];
            continue;
        }

        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find(close) else {
            return out; // opener with no close: drop through end of input
        };
        rest = &tail[end + close.len()..];
    }
}

/// Removes ``` and ~~~ fenced blocks, including unterminated ones.
fn remove_fenced_code(input: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    let mut fence_char = '`';

    for line in input.split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let c = trimmed
                .chars()
                .next()
                .expect("checked non-empty by starts_with");
            if !in_fence {
                in_fence = true;
                fence_char = c;
            } else if c == fence_char {
                in_fence = false;
            }
            continue;
        }
        if !in_fence {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Removes backtick spans. Unmatched trailing backticks are left alone.
fn remove_inline_code(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    loop {
        let Some(start) = rest.find('`') else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let Some(end) = tail.find('`') else {
            out.push_str(&rest[start..]);
            return out;
        };
        out.push(' ');
        rest = &tail[end + 1..];
    }
}

/// Blanks out bare filesystem paths, which carry directory names that read as
/// words (`~/.config/hell`, `src/assets`).
fn remove_paths(input: &str) -> String {
    input
        .split_whitespace()
        .filter(|tok| !is_path_like(tok))
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_path_like(tok: &str) -> bool {
    let t = tok
        .trim_start_matches([',', '.', ')', '('])
        .trim_end_matches([',', '.', ')', '(']);
    // Measured in UTF-8 bytes, as the original did.
    if t.len() < 3 {
        return false;
    }
    if t.starts_with('/') || t.starts_with("~/") || t.starts_with("./") || t.starts_with("../") {
        return true;
    }
    if !t.contains('/') {
        return false;
    }
    t.matches('/').count() >= 2
}
