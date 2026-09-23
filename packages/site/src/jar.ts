/**
 * The arithmetic behind the swear jar. The report page draws every swear as
 * one coin, so these helpers decide how full a jar is, what goes in each
 * day's stack, and how the numbers read. Kept free of React and the DOM so
 * the Worker's test pool can check them directly.
 */
import type { AgentDayStat, DayStat, HarnessStats } from "@salt/core";

export type Harness = HarnessStats["harness"];

/** Bottom of a stack first: the coins that went in first sit lowest. */
export const HARNESSES: Harness[] = ["claude", "codex", "cursor"];

/** 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 then the next power of ten. */
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * How many coins a jar holds: the total rounded up to a readable figure, so
 * a jar sits between about two thirds and full. Never under 10, so one coin
 * is a tenth of a jar at most.
 */
export function jarCapacity(...totals: number[]): number {
  const most = Math.max(0, ...totals);
  if (most <= 10) return 10;
  const power = 10 ** Math.floor(Math.log10(most));
  const step = STEPS.find((s) => s * power >= most)!;
  return step * power;
}

/** A jar's fill as a percentage of its capacity, never over the brim. */
export function fillPercent(coins: number, capacity: number): number {
  if (capacity <= 0 || coins <= 0) return 0;
  return Math.min(100, (coins / capacity) * 100);
}

/**
 * A share of the jar as a whole percent. A word that is in the jar at all
 * never reads as "0%", because it isn't.
 */
export function sharePercent(share: number): string {
  if (share <= 0) return "0%";
  const pct = share * 100;
  return pct < 0.5 ? "<1%" : `${Math.round(pct)}%`;
}

export interface Day {
  /** YYYY-MM-DD in the publisher's time zone, as the report carries it. */
  date: string;
  prompts: number;
  /** The publisher's own swears that day. */
  you: number;
  /** The agents' swears that day, per harness. */
  agents: Record<Harness, number>;
  agentTotal: number;
  /** Every coin that went in that day. */
  total: number;
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * One entry per calendar day from the first active day to the last, so the
 * gaps between stacks are real gaps in time. The agents' days count too: a
 * harness can reply on a day with no surviving prompt of the user's own.
 */
export function depositDays(daily: DayStat[], agentDaily: AgentDayStat[]): Day[] {
  const dates = [...daily.map((d) => d.date), ...agentDaily.map((d) => d.date)].sort();
  if (dates.length === 0) return [];

  const byDate = new Map<string, Day>();
  const blank = (date: string): Day => ({
    date,
    prompts: 0,
    you: 0,
    agents: { claude: 0, codex: 0, cursor: 0 },
    agentTotal: 0,
    total: 0,
  });

  const last = dates[dates.length - 1]!;
  // Bounded so a malformed date can never spin this forever.
  for (let date = dates[0]!, n = 0; date <= last && n < 3660; date = nextDate(date), n++) {
    byDate.set(date, blank(date));
  }

  for (const d of daily) {
    const day = byDate.get(d.date);
    if (!day) continue;
    day.prompts += d.prompts;
    day.you += d.swears;
    day.total += d.swears;
  }
  for (const d of agentDaily) {
    const day = byDate.get(d.date);
    if (!day) continue;
    day.agents[d.harness] += d.swears;
    day.agentTotal += d.swears;
    day.total += d.swears;
  }
  return [...byDate.values()];
}

/** The index of each month's first day, for the labels under the shelf. */
export function monthStarts(days: Day[]): { index: number; month: string }[] {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
  const out: { index: number; month: string }[] = [];
  days.forEach((d, i) => {
    if (i === 0 || d.date.endsWith("-01")) {
      out.push({ index: i, month: fmt.format(new Date(`${d.date}T00:00:00Z`)) });
    }
  });
  // A first label only a few days before the next month's would collide with it.
  if (out.length > 1 && out[1]!.index - out[0]!.index < Math.max(4, days.length * 0.06)) {
    out.shift();
  }
  return out;
}

/** "One prompt in 17", or the nearest honest sentence when that doesn't fit. */
export function oneIn(prompts: number, salty: number): number | null {
  if (salty <= 0 || prompts <= 0) return null;
  return Math.max(1, Math.round(prompts / salty));
}

/**
 * How the agents' swearing compares with yours, per message. The two rates
 * are per 100 prompts and per 100 replies, so the ratio is a like-for-like
 * "per message". A side with no swears at all gets its own sentence, since
 * a ratio against zero is no number to print.
 */
export function agentVerdict(
  you: { swears: number; per100: number },
  agent: { swears: number; per100: number; messages: number },
): string {
  if (agent.swears === 0) return `Not once in ${agent.messages.toLocaleString("en-US")} replies.`;
  if (you.swears === 0 || you.per100 <= 0) return "You never swore, so it out-swore you.";
  if (agent.per100 <= 0) return "About as often as you, per message.";
  const ratio = you.per100 / agent.per100;
  if (ratio >= 2) return `You swear ${ratio.toFixed(0)} times as often, per message.`;
  if (ratio <= 0.5) return `It swears ${(1 / ratio).toFixed(0)} times as often as you, per message.`;
  return "About as often as you, per message.";
}
