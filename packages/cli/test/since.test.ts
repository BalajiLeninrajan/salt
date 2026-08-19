import { describe, expect, test } from "bun:test";
import { dedup } from "../src/scan/index.js";
import { parseSince } from "../src/since.js";
import type { Message } from "../src/types.js";

describe("since", () => {
  test("parses spans and dates", () => {
    const d = parseSince("2026-01-01");
    expect(new Date(d).toISOString().slice(0, 10)).toBe("2026-01-01");

    const week = parseSince("7d");
    const delta = Math.floor((Date.now() - week) / 86_400_000);
    expect(delta).toBeGreaterThanOrEqual(6);
    expect(delta).toBeLessThanOrEqual(7);

    expect(() => parseSince("garbage")).toThrow();
    expect(() => parseSince("xd")).toThrow();
  });

  test("dedup collapses replays before the since filter", () => {
    // A replayed prompt's earliest occurrence predates the cutoff; collapsing
    // first (main.ts order: dedup, then filter ts >= since) keeps it out of
    // the report entirely rather than letting the fresh replay slip through.
    const replayed = (ts: number): Message => ({
      harness: "codex",
      role: "user",
      ts,
      tsPrecision: "exact",
      cwd: "/tmp/proj",
      sessionId: "s1",
      text: "replayed prompt",
    });
    const early = Date.parse("2026-08-01T10:00:00Z");
    const late = Date.parse("2026-08-17T10:00:00Z");
    const since = parseSince("2026-08-10");

    const messages = [replayed(late), replayed(early)];
    const dropped = dedup(messages);
    expect(dropped).toBe(1);
    // Dedup keeps the earliest occurrence, which the cutoff then removes.
    expect(messages).toHaveLength(1);
    expect(messages[0].ts).toBe(early);

    const filtered = messages.filter((p) => p.ts >= since);
    expect(filtered).toHaveLength(0);
  });
});
