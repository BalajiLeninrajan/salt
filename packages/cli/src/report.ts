// Aggregation — and the privacy boundary.
//
// Message text enters this module and does not leave it. Everything below is a
// count, a rate, or a matched lexicon word; nothing that reaches the browser,
// the cache, or stdout carries what was actually written.
//
// The user's side and the agent's side are aggregated separately. `totals`,
// `daily`, `heatmap`, and `projects` are all user-scoped; the agent gets its
// own counters rather than being folded into the headline number.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentDayStat,
  AgentHarnessStats,
  AgentTotals,
  DayStat,
  HeatCell,
  HarnessStats,
  ProjectStat,
  Report,
  Tier,
  Totals,
  WordStat,
} from "@salt/core";
import type { Matcher } from "./match.js";
import { cmpCodePoints, splitWhitespace } from "./text.js";
import type { Message, ScanStats } from "./types.js";
import { ALL_HARNESSES } from "./types.js";
import { VERSION } from "./version.js";

interface Bucket {
  prompts: number;
  swears: number;
  prompts_with_swear: number;
}

function bucketAdd(map: Map<string, Bucket>, key: string, swears: number): void {
  let b = map.get(key);
  if (!b) {
    b = { prompts: 0, swears: 0, prompts_with_swear: 0 };
    map.set(key, b);
  }
  b.prompts += 1;
  b.swears += swears;
  if (swears > 0) b.prompts_with_swear += 1;
}

function pairAdd(map: Map<string, [number, number]>, key: string, swears: number): void {
  const e = map.get(key) ?? [0, 0];
  e[0] += 1;
  e[1] += swears;
  map.set(key, e);
}

function rate(swears: number, prompts: number): number {
  return prompts === 0 ? 0 : (100 * swears) / prompts;
}

function wordCount(text: string): number {
  return splitWhitespace(text).length;
}

/**
 * Ranks matched words by frequency, ties broken alphabetically so the order is
 * stable across runs.
 */
function rankWords(counts: Map<string, { tier: Tier; count: number }>, total: number): WordStat[] {
  const out: WordStat[] = [...counts.entries()].map(([word, { tier, count }]) => ({
    word,
    tier,
    count,
    share: total === 0 ? 0 : count / total,
  }));
  out.sort((a, b) => b.count - a.count || cmpCodePoints(a.word, b.word));
  return out;
}

function countHits(
  counts: Map<string, { tier: Tier; count: number }>,
  hits: { word: string; tier: Tier }[],
): void {
  for (const h of hits) {
    const e = counts.get(h.word);
    if (e) e.count += 1;
    else counts.set(h.word, { tier: h.tier, count: 1 });
  }
}

export function buildReport(messages: Message[], stats: ScanStats, matcher: Matcher): Report {
  const totals: Totals = {
    sessions: 0,
    prompts: 0,
    words: 0,
    swears: 0,
    prompts_with_swear: 0,
    swears_per_100_prompts: 0,
  };

  const byHarness = new Map<string, Bucket>();
  const byDay = new Map<string, [number, number]>();
  const byCell = new Map<string, [number, number]>();
  const byProject = new Map<string, [number, number]>();
  const wordCounts = new Map<string, { tier: Tier; count: number }>();
  const sessions = new Set<string>();
  let sessionPrecision = 0;

  const agent: AgentTotals = {
    messages: 0,
    words: 0,
    swears: 0,
    messages_with_swear: 0,
    swears_per_100_messages: 0,
  };
  const agentByHarness = new Map<string, Bucket>();
  const agentByDay = new Map<string, [number, number]>();
  const agentWordCounts = new Map<string, { tier: Tier; count: number }>();

  for (const p of messages) {
    const hits = matcher.find(p.text);
    const swears = hits.length;
    const date = new Date(p.ts).toISOString().slice(0, 10);

    if (p.role === "agent") {
      agent.messages += 1;
      agent.words += wordCount(p.text);
      agent.swears += swears;
      if (swears > 0) agent.messages_with_swear += 1;
      countHits(agentWordCounts, hits);
      bucketAdd(agentByHarness, p.harness, swears);
      pairAdd(agentByDay, `${date}\x00${p.harness}`, swears);
      continue;
    }

    totals.prompts += 1;
    totals.words += wordCount(p.text);
    totals.swears += swears;
    if (swears > 0) totals.prompts_with_swear += 1;

    countHits(wordCounts, hits);

    sessions.add(`${p.harness}\x00${p.sessionId}`);
    bucketAdd(byHarness, p.harness, swears);

    // `daily` buckets by UTC date while the heatmap uses local wall-clock time
    // — a deliberate inconsistency inherited from v1: the timeline is a shared
    // calendar, the heatmap is about the shape of this user's day.
    pairAdd(byDay, date, swears);

    // Cursor stores no per-message time, so those prompts would smear the
    // heatmap across whatever hour the chat was last touched.
    if (p.tsPrecision === "exact") {
      const local = new Date(p.ts);
      pairAdd(byCell, `${(local.getDay() + 6) % 7}\x00${local.getHours()}`, swears);
    } else {
      sessionPrecision += 1;
    }

    if (p.cwd !== undefined) {
      const name = projectName(p.cwd);
      if (name !== null) pairAdd(byProject, name, swears);
    }
  }

  totals.sessions = sessions.size;
  totals.swears_per_100_prompts = rate(totals.swears, totals.prompts);
  agent.swears_per_100_messages = rate(agent.swears, agent.messages);

  const projects: ProjectStat[] = [...byProject.entries()].map(([name, [prompts, swears]]) => ({
    name,
    prompts,
    swears,
    rate: rate(swears, prompts),
  }));
  projects.sort(
    (a, b) => b.swears - a.swears || b.prompts - a.prompts || cmpCodePoints(a.name, b.name),
  );

  const heatmap: HeatCell[] = [...byCell.entries()].map(([key, [prompts, swears]]) => {
    const [dow, hour] = key.split("\x00").map(Number);
    return { dow, hour, prompts, swears };
  });
  heatmap.sort((a, b) => a.dow - b.dow || a.hour - b.hour);

  const harnessStats = (map: Map<string, Bucket>): HarnessStats[] =>
    ALL_HARNESSES.filter((h) => map.has(h)).map((h) => {
      const b = map.get(h)!;
      return {
        harness: h,
        prompts: b.prompts,
        swears: b.swears,
        prompts_with_swear: b.prompts_with_swear,
        rate: rate(b.swears, b.prompts),
      };
    });

  const agentByHarnessOut: AgentHarnessStats[] = harnessStats(agentByHarness).map((s) => ({
    harness: s.harness,
    messages: s.prompts,
    swears: s.swears,
    messages_with_swear: s.prompts_with_swear,
    rate: s.rate,
  }));

  const daily: DayStat[] = [...byDay.keys()].sort().map((date) => {
    const [prompts, swears] = byDay.get(date)!;
    return { date, prompts, swears };
  });

  // Days a harness was idle are absent rather than zero-filled; the chart
  // reads a gap as zero.
  const agentDaily: AgentDayStat[] = [...agentByDay.keys()].sort().map((key) => {
    const [date, harness] = key.split("\x00");
    const [messages, swears] = agentByDay.get(key)!;
    return { date, harness: harness as AgentDayStat["harness"], messages, swears };
  });

  const notes: string[] = [];
  if (sessionPrecision > 0) {
    notes.push(
      `${sessionPrecision} Cursor prompts have session-level timestamps only and are excluded from the heatmap.`,
    );
  }
  if (stats.files_failed > 0) {
    notes.push(`${stats.files_failed} files could not be read.`);
  }
  if (stats.duplicates_dropped > 0) {
    notes.push(
      `${stats.duplicates_dropped} replayed prompts were collapsed; agent harnesses rewrite session history on fork and resume.`,
    );
  }

  // Field order mirrors the serialised Rust struct, byte for byte.
  return {
    generated_at: new Date().toISOString(),
    version: VERSION,
    totals,
    by_harness: harnessStats(byHarness),
    top_words: rankWords(wordCounts, totals.swears),
    daily,
    heatmap,
    projects,
    agent,
    agent_by_harness: agentByHarnessOut,
    agent_daily: agentDaily,
    agent_top_words: rankWords(agentWordCounts, agent.swears),
    coverage: {
      files_scanned: stats.files_scanned,
      files_failed: stats.files_failed,
      bytes_scanned: stats.bytes_scanned,
      duplicates_dropped: stats.duplicates_dropped,
      session_precision_prompts: sessionPrecision,
      notes,
    },
  };
}

/**
 * Reduces a working directory to a shareable project name: the basename of the
 * enclosing git repository, else the leaf directory.
 *
 * Paths compare the way v1's `std::path::Path` did — `//` collapsed, a
 * non-leading `.` normalized away, `..` left alone — so no spelling of the
 * home directory (`/Users/name/.`, `/Users//name`) slips past the exclusion.
 */
export function projectName(cwd: string): string | null {
  const path = components(cwd);
  // The home directory is not a project; prompts typed there would otherwise
  // rank as one and expose the account name.
  const home = components(homedir());
  if (path.root === home.root && listEq(path.parts, home.parts)) return null;

  // Walk to the filesystem root — or, for a relative path, to "" — exactly
  // the ancestor chain `Path::parent` produces.
  for (let n = path.parts.length; n >= 0; n--) {
    if (existsSync(join(pathOf(path.root, path.parts.slice(0, n)), ".git"))) {
      return fileName(path.parts.slice(0, n));
    }
  }
  return fileName(path.parts);
}

/** Normalized path components plus whether the path was absolute. */
function components(path: string): { root: boolean; parts: string[] } {
  const root = path.startsWith("/");
  const segs = path.split("/").filter((seg) => seg !== "");
  // `.` survives only as the first component of a relative path.
  const parts = segs.filter((seg, i) => seg !== "." || (i === 0 && !root));
  return { root, parts };
}

function pathOf(root: boolean, parts: string[]): string {
  return (root ? "/" : "") + parts.join("/");
}

/** `Path::file_name`: none for an empty path or one ending in `.` or `..`. */
function fileName(parts: string[]): string | null {
  const last = parts[parts.length - 1];
  return last === undefined || last === "." || last === ".." ? null : last;
}

function listEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
