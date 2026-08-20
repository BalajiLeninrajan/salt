// Worker fan-out for the scan.
//
// Files never interact until dedup, so the scan is embarrassingly parallel.
// Left serial it is pure CPU waste: the full corpus measured 23.6s at 105% CPU
// on a 10-core machine whose disk sustains ~4.5 GB/s across threads, against a
// ~3.5s read floor for the same bytes. Fanning out puts the scan back on the
// disk rather than on one core.
//
// The worker entry is the CLI's own entry module, re-executed with
// `isMainThread === false`. That indirection is not stylistic: `bun build
// --compile` embeds only the entry point, so a separate worker file resolves
// to `/$bunfs/root/<name>.ts` and dies with ModuleNotFound in the shipped
// binaries. Pointing the Worker at the entry itself is what keeps them working.

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type { Harness, Message } from "../types.js";
import { dedup } from "./dedup.js";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as cursor from "./cursor.js";

/** A file to parse, with the size the scan will bill it at. */
export type SizedJob = [Harness, string, number];

export interface ShardResult {
  messages: Message[];
  /** Parsed before the shard-local dedup, so the caller can total the drops. */
  raw: number;
  failed: number;
}

type WorkerMsg =
  | { kind: "progress"; files: number; bytes: number }
  | { kind: "done"; messages: Message[]; raw: number; failed: number };

/** Report progress at most this often, to keep postMessage off the hot path. */
const PROGRESS_BYTES = 64 << 20;

/**
 * Parses a shard of files. Runs on a worker thread, and inline on the main
 * thread when the corpus is too small to be worth spawning any.
 */
export async function parseShard(
  jobs: readonly SizedJob[],
  onProgress?: (files: number, bytes: number) => void,
): Promise<ShardResult> {
  const messages: Message[] = [];
  let failed = 0;
  let files = 0;
  let bytes = 0;

  for (const [harness, path, size] of jobs) {
    files += 1;
    bytes += size;
    try {
      const parsed =
        harness === "claude"
          ? await claude.parseFile(path)
          : harness === "codex"
            ? await codex.parseFile(path)
            : await cursor.parseDb(path);
      for (const m of parsed) messages.push(m);
    } catch {
      failed += 1;
    }
    if (bytes >= PROGRESS_BYTES && onProgress) {
      onProgress(files, bytes);
      files = 0;
      bytes = 0;
    }
  }
  if (onProgress && (files > 0 || bytes > 0)) onProgress(files, bytes);

  // Collapsing here moves roughly a third of the corpus's messages off the
  // structured-clone path back to the main thread; the merge dedups again.
  const raw = messages.length;
  dedup(messages);
  return { messages, raw, failed };
}

/**
 * Splits jobs across `n` shards by size, largest first into whichever shard is
 * currently lightest. File sizes span six orders of magnitude here (the corpus
 * holds a 265 MB rollout next to 4 KB ones), so round-robin would leave the
 * scan waiting on one unlucky worker.
 */
export function shard(jobs: readonly SizedJob[], n: number): SizedJob[][] {
  const shards: SizedJob[][] = Array.from({ length: n }, () => []);
  const load = new Float64Array(n);
  const order = [...jobs].sort((a, b) => b[2] - a[2]);
  for (const job of order) {
    let min = 0;
    for (let i = 1; i < n; i++) if (load[i]! < load[min]!) min = i;
    shards[min]!.push(job);
    load[min]! += job[2];
  }
  return shards.filter((s) => s.length > 0);
}

/**
 * How many workers to spawn; never more than there are files to hand out.
 *
 * Deliberately oversubscribed. Each worker alternates between blocking on the
 * disk and burning CPU on the gate, so running one thread per core leaves the
 * disk idle during every scan phase. Measured over the full corpus, aggregate
 * throughput rose from 3.80 GB/s at one-per-core to 3.94 GB/s at double, and
 * was flat beyond ~16 — hence the cap, which also bounds worker heap count.
 */
export function workerCount(jobs: readonly SizedJob[]): number {
  let cores = 4;
  try {
    cores = availableParallelism();
  } catch {
    // older runtimes: fall back to a conservative fan-out
  }
  return Math.max(1, Math.min(cores * 2, 16, jobs.length));
}

/** Runs the shards on worker threads, resolving once every one has reported. */
export function runPool(
  jobs: readonly SizedJob[],
  entry: string | URL,
  onProgress?: (files: number, bytes: number) => void,
): Promise<ShardResult[]> {
  const shards = shard(jobs, workerCount(jobs));
  return new Promise((resolve, reject) => {
    const results: ShardResult[] = [];
    let live = shards.length;
    let settled = false;

    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    for (const jobsForShard of shards) {
      const worker = new Worker(entry, { workerData: { saltShard: jobsForShard } });
      worker.on("message", (msg: WorkerMsg) => {
        if (msg.kind === "progress") onProgress?.(msg.files, msg.bytes);
        else results.push({ messages: msg.messages, raw: msg.raw, failed: msg.failed });
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        // A worker that dies without reporting would silently shrink the scan,
        // so an unclean exit fails the run rather than undercounting.
        if (code !== 0) return fail(new Error(`scan worker exited with code ${code}`));
        if (--live === 0 && !settled) {
          settled = true;
          resolve(results);
        }
      });
    }
  });
}

/**
 * Worker-thread entry. The CLI entry module calls this instead of running the
 * command when it finds itself off the main thread.
 */
export async function runScanWorker(workerData: unknown, post: (msg: unknown) => void): Promise<void> {
  const jobs = (workerData as { saltShard?: SizedJob[] } | null)?.saltShard ?? [];
  const result = await parseShard(jobs, (files, bytes) => post({ kind: "progress", files, bytes }));
  post({ kind: "done", messages: result.messages, raw: result.raw, failed: result.failed });
}
