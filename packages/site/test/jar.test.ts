import { describe, expect, it } from "vitest";
import type { AgentDayStat, DayStat } from "@salt/core";
import {
  agentVerdict,
  coinPile,
  depositDays,
  fillPercent,
  jarCapacity,
  monthStarts,
  oneIn,
  sharePercent,
} from "../src/jar";

describe("jarCapacity", () => {
  it("rounds the fullest jar up to a readable figure", () => {
    expect(jarCapacity(662, 18)).toBe(800);
    expect(jarCapacity(18, 662)).toBe(800);
    expect(jarCapacity(1000)).toBe(1000);
    expect(jarCapacity(1001)).toBe(1500);
    expect(jarCapacity(42)).toBe(50);
  });

  it("never drops below ten coins, even for an empty jar", () => {
    expect(jarCapacity(0, 0)).toBe(10);
    expect(jarCapacity(3)).toBe(10);
  });
});

describe("fillPercent", () => {
  it("fills each jar against its own capacity", () => {
    expect(fillPercent(662, 800)).toBeCloseTo(82.75);
    expect(fillPercent(4, jarCapacity(4))).toBeCloseTo(40);
  });

  it("never goes over the brim or below empty", () => {
    expect(fillPercent(900, 800)).toBe(100);
    expect(fillPercent(0, 800)).toBe(0);
    expect(fillPercent(5, 0)).toBe(0);
  });
});

describe("coinPile", () => {
  it("draws nothing for an empty jar and a coin for a nearly empty one", () => {
    expect(coinPile(0, 7.5, 154)).toEqual([]);
    expect(coinPile(1, 7.5, 154).length).toBeGreaterThan(0);
  });

  it("stacks higher as the jar fills, with the pile stopping near the fill line", () => {
    const half = coinPile(50, 7.5, 154);
    const full = coinPile(100, 7.5, 154);
    expect(full.length).toBeGreaterThan(half.length);
    // The row the fill line crosses can stand up to one coin above it.
    expect(Math.min(...half.map((c) => c.y - c.r))).toBeGreaterThan(154 * 0.5 - 15);
  });

  it("runs full rows past both walls, for the glass to clip", () => {
    const full = coinPile(100, 7.5, 154);
    const floor = full.filter((c) => c.y === full[0]!.y);
    expect(Math.min(...floor.map((c) => c.x - c.r))).toBeLessThan(0);
    expect(Math.max(...floor.map((c) => c.x + c.r))).toBeGreaterThan(100);
  });

  it("orders coins bottom first and draws the same pile every time", () => {
    const pile = coinPile(80, 7.5, 154);
    expect(pile[0]!.at).toBe(0);
    expect(pile.every((c, i) => i === 0 || c.at > pile[i - 1]!.at)).toBe(true);
    expect(coinPile(80, 7.5, 154)).toEqual(pile);
  });
});

describe("sharePercent", () => {
  it("shows a word that is in the jar as more than nothing", () => {
    expect(sharePercent(0.004)).toBe("<1%");
    expect(sharePercent(0.0045)).toBe("<1%");
    expect(sharePercent(0.005)).toBe("1%");
    expect(sharePercent(0)).toBe("0%");
    expect(sharePercent(0.3207)).toBe("32%");
  });
});

describe("oneIn", () => {
  it("rounds prompts per salty prompt", () => {
    expect(oneIn(9312, 540)).toBe(17);
    expect(oneIn(10, 10)).toBe(1);
    expect(oneIn(10, 0)).toBeNull();
  });
});

describe("depositDays", () => {
  const daily: DayStat[] = [
    { date: "2026-06-29", prompts: 10, swears: 3, weight: 30 },
    { date: "2026-07-02", prompts: 5, swears: 1, weight: 5 },
  ];
  const agentDaily: AgentDayStat[] = [
    { date: "2026-06-29", harness: "claude", messages: 12, swears: 2 },
    { date: "2026-06-29", harness: "codex", messages: 4, swears: 0 },
    // A reply on a day with no prompt of the user's own still gets a stack.
    { date: "2026-07-03", harness: "cursor", messages: 3, swears: 1 },
  ];

  it("fills every calendar day between the first and the last", () => {
    const days = depositDays(daily, agentDaily);
    expect(days.map((d) => d.date)).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  it("stacks the agents' coins on the user's", () => {
    const [first, , , , last] = depositDays(daily, agentDaily);
    expect(first).toMatchObject({ you: 3, agentTotal: 2, total: 5, prompts: 10 });
    expect(first!.agents).toEqual({ claude: 2, codex: 0, cursor: 0 });
    expect(last).toMatchObject({ you: 0, prompts: 0, total: 1 });
    expect(last!.agents.cursor).toBe(1);
  });

  it("is empty with no days at all", () => {
    expect(depositDays([], [])).toEqual([]);
  });
});

describe("monthStarts", () => {
  it("labels each month where it starts and drops a crowded first label", () => {
    const days = depositDays(
      [
        { date: "2026-06-29", prompts: 1, swears: 1, weight: 5 },
        { date: "2026-08-15", prompts: 1, swears: 1, weight: 5 },
      ],
      [],
    );
    expect(monthStarts(days).map((m) => m.month)).toEqual(["Jul", "Aug"]);
  });

  it("keeps the first label when the next month is far away", () => {
    const days = depositDays(
      [
        { date: "2026-06-10", prompts: 1, swears: 1, weight: 5 },
        { date: "2026-07-20", prompts: 1, swears: 1, weight: 5 },
      ],
      [],
    );
    expect(monthStarts(days)).toEqual([
      { index: 0, month: "Jun" },
      { index: 21, month: "Jul" },
    ]);
  });
});

describe("agentVerdict", () => {
  const agent = (swears: number, per100: number) => ({ swears, per100, messages: 15000 });

  it("says so when the agent never swore", () => {
    expect(agentVerdict({ swears: 662, per100: 7.1 }, agent(0, 0))).toBe(
      "Not once in 15,000 replies.",
    );
  });

  it("never prints Infinity when you never swore", () => {
    const v = agentVerdict({ swears: 0, per100: 0 }, agent(18, 0.12));
    expect(v).toBe("You never swore, so it out-swore you.");
    expect(v).not.toContain("Infinity");
  });

  it("puts the bigger swearer first", () => {
    expect(agentVerdict({ swears: 662, per100: 7.1 }, agent(18, 0.12))).toBe(
      "You swear 59 times as often, per message.",
    );
    expect(agentVerdict({ swears: 3, per100: 0.1 }, agent(90, 0.6))).toBe(
      "It swears 6 times as often as you, per message.",
    );
  });

  it("calls near-equal rates even", () => {
    expect(agentVerdict({ swears: 10, per100: 1 }, agent(12, 1.2))).toBe(
      "About as often as you, per message.",
    );
    expect(agentVerdict({ swears: 10, per100: 1 }, agent(9, 0.9))).toBe(
      "About as often as you, per message.",
    );
  });
});
