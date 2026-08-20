import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness, Message, ScanStats } from "../types.js";
import { dedup } from "./dedup.js";
import { type SizedJob, parseShard, runPool } from "./pool.js";

export { dedup };

export interface ScanOutput {
  messages: Message[];
  stats: ScanStats;
}

export interface ScanProgress {
  files: number;
  totalFiles: number;
  bytes: number;
}

/** Recursively collects files under `root` whose path matches `pred`. */
function collectFiles(root: string, pred: (p: string) => boolean, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) collectFiles(path, pred, out);
    else if (entry.isFile() && pred(path)) out.push(path);
  }
}

const isJsonl = (p: string) => p.endsWith(".jsonl");
const isStoreDb = (p: string) => p.endsWith("/store.db") || p.endsWith("\\store.db");

function existingDir(p: string): string | null {
  try {
    return statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

export function jobsFor(harnesses: Harness[], home = homedir()): [Harness, string][] {
  const jobs: [Harness, string][] = [];
  const add = (harness: Harness, root: string | null, pred: (p: string) => boolean) => {
    if (!root) return;
    const files: string[] = [];
    collectFiles(root, pred, files);
    for (const f of files) jobs.push([harness, f]);
  };

  if (harnesses.includes("claude")) {
    add("claude", existingDir(join(home, ".claude", "projects")), isJsonl);
  }
  if (harnesses.includes("codex")) {
    add("codex", existingDir(join(home, ".codex", "sessions")), isJsonl);
    add("codex", existingDir(join(home, ".codex", "archived_sessions")), isJsonl);
  }
  if (harnesses.includes("cursor")) {
    add("cursor", existingDir(join(home, ".cursor", "chats")), isStoreDb);
  }
  return jobs;
}

/**
 * Where the scan sends its workers. The CLI entry module registers itself here
 * because `bun build --compile` only embeds the entry point — see pool.ts.
 * Left unset (tests, library use) the scan simply runs on the calling thread.
 */
let workerEntry: string | URL | null = null;

export function setWorkerEntry(entry: string | URL): void {
  workerEntry = entry;
}

/**
 * Below this much data the thread spawns cost more than they save, so small
 * corpora — which is most people's — stay on one thread and start instantly.
 */
const PARALLEL_MIN_BYTES = 128 << 20;

/** Scans every requested harness, reporting progress as files are consumed. */
export async function scan(
  harnesses: Harness[],
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanOutput> {
  const found = jobsFor(harnesses);
  const jobs: SizedJob[] = found.map(([harness, path]) => {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // treated like Rust's metadata().len() fallback of 0
    }
    return [harness, path, size];
  });

  const totalBytes = jobs.reduce((n, j) => n + j[2], 0);
  const stats: ScanStats = {
    files_scanned: jobs.length,
    files_failed: 0,
    bytes_scanned: totalBytes,
    duplicates_dropped: 0,
  };

  // Progress is reported against the totals computed up front, so it stays
  // monotonic however the work is divided.
  let seenFiles = 0;
  let seenBytes = 0;
  const report = (files: number, bytes: number) => {
    seenFiles += files;
    seenBytes += bytes;
    onProgress?.({ files: seenFiles, totalFiles: jobs.length, bytes: seenBytes });
  };

  const parallel = workerEntry !== null && totalBytes >= PARALLEL_MIN_BYTES && jobs.length > 1;
  const shards = parallel
    ? await runPool(jobs, workerEntry!, report)
    : [await parseShard(jobs, report)];

  let raw = 0;
  const messages: Message[] = [];
  for (const s of shards) {
    raw += s.raw;
    stats.files_failed += s.failed;
    for (const m of s.messages) messages.push(m);
  }

  // Each shard already collapsed its own replays; this catches the ones that
  // straddle shards. Dropped is counted against the pre-collapse total so the
  // number means the same thing however many threads ran.
  dedup(messages);
  stats.duplicates_dropped = raw - messages.length;

  return { messages, stats };
}
