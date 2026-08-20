export type Tier = "mild" | "medium" | "strong" | "acronym";

export interface Totals {
  sessions: number;
  prompts: number;
  words: number;
  swears: number;
  prompts_with_swear: number;
  swears_per_100_prompts: number;
}

export interface HarnessStats {
  harness: "claude" | "codex" | "cursor";
  prompts: number;
  swears: number;
  prompts_with_swear: number;
  rate: number;
}

export interface AgentTotals {
  messages: number;
  words: number;
  swears: number;
  messages_with_swear: number;
  swears_per_100_messages: number;
}

export interface AgentHarnessStats {
  harness: HarnessStats["harness"];
  messages: number;
  swears: number;
  messages_with_swear: number;
  rate: number;
}

export interface WordStat { word: string; tier: Tier; count: number; share: number }
export interface DayStat {
  date: string;
  prompts: number;
  swears: number;
  /** Sum of TIER_WEIGHT over that day's swears; what the calendar shades by. */
  weight: number;
}
export interface AgentDayStat {
  date: string;
  harness: HarnessStats["harness"];
  messages: number;
  swears: number;
}
export interface ProjectStat { name: string; prompts: number; swears: number; rate: number }

export interface Coverage {
  files_scanned: number;
  files_failed: number;
  bytes_scanned: number;
  duplicates_dropped: number;
  session_precision_prompts: number;
  notes: string[];
}

export interface Report {
  generated_at: string;
  version: string;
  totals: Totals;
  by_harness: HarnessStats[];
  top_words: WordStat[];
  daily: DayStat[];
  projects: ProjectStat[];
  agent: AgentTotals;
  agent_by_harness: AgentHarnessStats[];
  agent_daily: AgentDayStat[];
  agent_top_words: WordStat[];
  coverage: Coverage;
}

/**
 * Severity weights. A single "fuck" should outweigh a single "damn" rather
 * than counting the same; acronyms sit just under the strong words they stand
 * in for. Used by the calendar so a day's intensity tracks how hard it swore,
 * not just how often.
 */
export const TIER_WEIGHT: Record<Tier, number> = {
  mild: 5,
  medium: 8,
  strong: 10,
  acronym: 6,
};

/** Tier drives the accent channel on word rows and the share card. */
export const TIER_COLOR: Record<Tier, string> = {
  mild: "var(--overlay-2)",
  medium: "var(--yellow)",
  strong: "var(--red)",
  acronym: "var(--peach)",
};

export const HARNESS_LABEL: Record<HarnessStats["harness"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Per-entity colors: Mocha peach, green, and blue. */
export const HARNESS_COLOR: Record<HarnessStats["harness"], string> = {
  claude: "#fab387",
  codex: "#a6e3a1",
  cursor: "#89b4fa",
};

/**
 * Agent series on the timeline. One color per harness everywhere: these match
 * HARNESS_COLOR, and the user's line is distinguished by being the only mauve.
 */
export const AGENT_LINE_COLOR: Record<HarnessStats["harness"], string> = {
  claude: "var(--peach)",
  codex: "var(--green)",
  cursor: "var(--blue)",
};

/**
 * The publishing limits, shared so the CLI, the Worker, and the dashboard
 * cannot disagree about them.
 *
 * These were previously literals in three places — the Worker, the CLI, and
 * App.tsx — each with a comment pointing at the others. That is exactly the
 * arrangement that drifts.
 */

/** Generous for a report, small enough that nobody stores a filesystem in KV. */
export const MAX_REPORT_BYTES = 512 * 1024;

/** A published report is a snapshot; links are kept this long after it. */
export const REPORT_TTL_DAYS = 30;

export const REPORT_TTL_SECONDS = REPORT_TTL_DAYS * 24 * 60 * 60;
