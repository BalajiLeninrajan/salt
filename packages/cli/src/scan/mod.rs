//! Harness discovery, file scanning, and dedup.

pub mod claude;
pub mod codex;
pub mod cursor;

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use rayon::prelude::*;

use crate::types::{Harness, Message, ScanStats};

#[derive(Debug, Default)]
pub struct ScanOutput {
    pub messages: Vec<Message>,
    pub stats: ScanStats,
}

/// A file to parse, with the size the scan will bill it at.
pub type Job = (Harness, PathBuf, u64);

/// Recursively collects files under `root` whose path matches `pred`.
///
/// Unreadable directories are skipped rather than failing the scan — a corpus
/// spanning three tools on a real machine will always contain something the
/// current user cannot read.
fn collect_files(root: &Path, pred: &dyn Fn(&Path) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // `file_type` rather than `path.is_dir()` so symlinks are not followed
        // into a cycle.
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_files(&path, pred, out);
        } else if ft.is_file() && pred(&path) {
            out.push(path);
        }
    }
}

fn existing_dir(p: PathBuf) -> Option<PathBuf> {
    p.is_dir().then_some(p)
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().is_some_and(|e| e == "jsonl")
}

fn is_store_db(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n == "store.db")
}

/// Every file the requested harnesses want scanned, with its billed size.
pub fn jobs_for(harnesses: &[Harness], home: &Path) -> Vec<Job> {
    let mut jobs: Vec<Job> = Vec::new();

    let mut add = |harness: Harness, root: Option<PathBuf>, pred: &dyn Fn(&Path) -> bool| {
        let Some(root) = root else { return };
        let mut files = Vec::new();
        collect_files(&root, pred, &mut files);
        for f in files {
            // Size is read here, once, so `bytes_scanned` counts a file even
            // when parsing it later fails.
            let size = fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            jobs.push((harness, f, size));
        }
    };

    if harnesses.contains(&Harness::Claude) {
        add(Harness::Claude, existing_dir(home.join(".claude").join("projects")), &is_jsonl);
    }
    if harnesses.contains(&Harness::Codex) {
        add(Harness::Codex, existing_dir(home.join(".codex").join("sessions")), &is_jsonl);
        add(
            Harness::Codex,
            existing_dir(home.join(".codex").join("archived_sessions")),
            &is_jsonl,
        );
    }
    if harnesses.contains(&Harness::Cursor) {
        add(Harness::Cursor, existing_dir(home.join(".cursor").join("chats")), &is_store_db);
    }
    jobs
}

/// Parses one file, dispatching on its harness.
pub fn parse_job(harness: Harness, path: &Path) -> anyhow::Result<Vec<Message>> {
    match harness {
        Harness::Claude => claude::parse_file(path),
        Harness::Codex => codex::parse_file(path),
        Harness::Cursor => cursor::parse_db(path),
    }
}

/// The identity of a message for dedup purposes: same text, same session, same
/// speaker. Deliberately excludes the timestamp — that is the whole point.
fn dedup_key(m: &Message) -> (Harness, crate::types::Role, &str, &str) {
    (m.harness, m.role, m.session_id.as_str(), m.text.as_str())
}

/// Collapses replayed messages, keeping the earliest occurrence of each.
///
/// Codex rewrites a session's entire history into a new rollout file on every
/// fork and resume; a single prompt was observed 405 times in the corpus this
/// was built against, and two thirds of everything parsed is replay. Replays
/// are stamped with fresh timestamps, so time cannot distinguish them — but a
/// given text within a given session is one message however many files it
/// lands in. Agent replies are replayed by the same mechanism, so they get the
/// same treatment.
///
/// The cost is that genuinely repeating the same text twice in one session
/// counts once. That undercounts slightly, which is the right direction to err
/// versus inflating the headline number ~1.4x.
///
/// The survivor is the one with the smallest timestamp, ties broken by the
/// smallest `cwd`. Both the TypeScript implementation and the original Rust
/// relied on a stable sort of whatever order the threads happened to produce,
/// which meant a timestamp tie could attribute a prompt to a different project
/// between two runs on identical input. Sorting on the full key makes the
/// result independent of scheduling, which is what lets a parallel scan be
/// checked against a golden report at all.
pub fn dedup(messages: &mut Vec<Message>) -> u64 {
    let before = messages.len();

    messages.sort_by(|a, b| {
        dedup_key(a)
            .cmp(&dedup_key(b))
            .then_with(|| a.ts.cmp(&b.ts))
            .then_with(|| match (&a.cwd, &b.cwd) {
                // `None` sorts before `Some` so a message with no project is
                // only chosen when nothing better shares its key.
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Less,
                (Some(_), None) => Ordering::Greater,
                (Some(x), Some(y)) => x.cmp(y),
            })
    });
    // The sort put the winner of each key first, so keeping the first of every
    // run of equal keys is exactly "earliest, then smallest cwd".
    messages.dedup_by(|a, b| dedup_key(a) == dedup_key(b));

    // Chronological is the order a reader would expect if this ever surfaces,
    // and it costs nothing here.
    messages.sort_by_key(|m| m.ts);

    (before - messages.len()) as u64
}

/// Scans every requested harness.
pub fn scan(harnesses: &[Harness], home: &Path) -> ScanOutput {
    scan_with(harnesses, home, |_, _, _| {})
}

/// As [`scan`], reporting `(files_done, files_total, bytes_done)` as it goes.
///
/// Files never interact until dedup, so this is embarrassingly parallel and
/// rayon's work-stealing keeps every core fed. The corpus this was built
/// against is ~16 GB across ~7,900 files, where one thread is pure waste: the
/// disk sustains several GB/s across threads while a single reader cannot.
///
/// `on_progress` is called from worker threads, hence `Sync`.
pub fn scan_with(
    harnesses: &[Harness],
    home: &Path,
    on_progress: impl Fn(u64, u64, u64) + Sync,
) -> ScanOutput {
    let mut jobs = jobs_for(harnesses, home);

    let stats = ScanStats {
        files_scanned: jobs.len() as u64,
        files_failed: 0,
        bytes_scanned: jobs.iter().map(|(_, _, size)| size).sum(),
        duplicates_dropped: 0,
    };

    // Largest first. File sizes here span six orders of magnitude — a 265 MB
    // rollout sits next to 4 KB ones — and starting with the big ones stops
    // the run ending while every core waits on one straggler.
    jobs.sort_by(|a, b| b.2.cmp(&a.2));

    let total = jobs.len() as u64;
    let done = AtomicU64::new(0);
    let bytes = AtomicU64::new(0);

    let (mut messages, files_failed) = jobs
        .par_iter()
        .fold(
            || (Vec::new(), 0u64),
            |(mut msgs, mut failed), (harness, path, size)| {
                match parse_job(*harness, path) {
                    Ok(parsed) => msgs.extend(parsed),
                    Err(_) => failed += 1,
                }
                let d = done.fetch_add(1, AtomicOrdering::Relaxed) + 1;
                let b = bytes.fetch_add(*size, AtomicOrdering::Relaxed) + size;
                on_progress(d, total, b);
                (msgs, failed)
            },
        )
        .reduce(
            || (Vec::new(), 0u64),
            |(mut a, af), (b, bf)| {
                a.extend(b);
                (a, af + bf)
            },
        );

    let duplicates_dropped = dedup(&mut messages);
    ScanOutput {
        messages,
        stats: ScanStats { files_failed, duplicates_dropped, ..stats },
    }
}
