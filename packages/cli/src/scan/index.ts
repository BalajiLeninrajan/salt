import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness, Message, ScanStats } from "../types.js";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as cursor from "./cursor.js";

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

/** Scans every requested harness, reporting progress after each file. */
export async function scan(
  harnesses: Harness[],
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanOutput> {
  const jobs = jobsFor(harnesses);
  const out: ScanOutput = {
    messages: [],
    stats: { files_scanned: 0, files_failed: 0, bytes_scanned: 0, duplicates_dropped: 0 },
  };

  for (const [harness, path] of jobs) {
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      // treated like Rust's metadata().len() fallback of 0
    }
    out.stats.files_scanned += 1;
    out.stats.bytes_scanned += bytes;
    try {
      const messages =
        harness === "claude"
          ? await claude.parseFile(path)
          : harness === "codex"
            ? await codex.parseFile(path)
            : await cursor.parseDb(path);
      out.messages.push(...messages);
    } catch {
      out.stats.files_failed += 1;
    }
    onProgress?.({
      files: out.stats.files_scanned,
      totalFiles: jobs.length,
      bytes: out.stats.bytes_scanned,
    });
  }

  out.stats.duplicates_dropped = dedup(out.messages);
  return out;
}

/**
 * Collapses replayed messages, keeping the earliest occurrence of each.
 *
 * Codex rewrites a session's entire history into a new rollout file on every
 * fork and resume; a single prompt was observed 405 times in the corpus this
 * was built against. Replays are stamped with fresh timestamps, so time cannot
 * distinguish them — but a given text within a given session is one message
 * however many files it lands in. Agent replies are replayed by exactly the
 * same mechanism, so they get the same treatment.
 *
 * The cost is that genuinely repeating the same text twice in one session
 * counts once. That undercounts slightly, which is the right direction to err
 * versus inflating the headline number ~1.4x.
 */
export function dedup(messages: Message[]): number {
  const before = messages.length;
  messages.sort((a, b) => a.ts - b.ts);
  const seen = new Set<string>();
  let write = 0;
  for (const m of messages) {
    const key = `${m.harness}\x00${m.role}\x00${m.sessionId}\x00${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages[write++] = m;
  }
  messages.length = write;
  return before - messages.length;
}
