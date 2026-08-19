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
export interface DayStat { date: string; prompts: number; swears: number }
export interface AgentDayStat {
  date: string;
  harness: HarnessStats["harness"];
  messages: number;
  swears: number;
}
export interface HeatCell { dow: number; hour: number; prompts: number; swears: number }
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
  heatmap: HeatCell[];
  projects: ProjectStat[];
  agent: AgentTotals;
  agent_by_harness: AgentHarnessStats[];
  agent_daily: AgentDayStat[];
  agent_top_words: WordStat[];
  coverage: Coverage;
}

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
 * Agent series on the timeline. Deliberately distinct from HARNESS_COLOR: these
 * lines sit on the same axes as the user's mauve swear line, so they need to
 * read as a separate family rather than echo the harness cards above.
 */
export const AGENT_LINE_COLOR: Record<HarnessStats["harness"], string> = {
  claude: "var(--yellow)",
  codex: "var(--teal)",
  cursor: "var(--pink)",
};
