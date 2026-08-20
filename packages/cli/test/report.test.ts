import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Matcher } from "../src/match.js";
import { buildReport, projectName } from "../src/report.js";
import type { Harness, Message, Role, ScanStats, TsPrecision } from "../src/types.js";

function message(
  text: string,
  ts: string,
  harness: Harness,
  precision: TsPrecision,
  role: Role,
): Message {
  return {
    harness,
    role,
    ts: Date.parse(ts),
    tsPrecision: precision,
    cwd: "/tmp/proj",
    sessionId: "s1",
    text,
  };
}

function prompt(text: string, ts: string, harness: Harness, precision: TsPrecision): Message {
  return message(text, ts, harness, precision, "user");
}

function reply(text: string, ts: string, harness: Harness): Message {
  return message(text, ts, harness, "exact", "agent");
}

const emptyStats = (): ScanStats => ({
  files_scanned: 0,
  files_failed: 0,
  bytes_scanned: 0,
  duplicates_dropped: 0,
});

function buildFrom(messages: Message[]) {
  return buildReport(messages, emptyStats(), new Matcher());
}

describe("report", () => {
  test("counts totals and rates", () => {
    const r = buildFrom([
      prompt("this is fucking broken", "2026-08-17T10:00:00Z", "claude", "exact"),
      prompt("looks fine", "2026-08-17T11:00:00Z", "claude", "exact"),
    ]);
    expect(r.totals.prompts).toBe(2);
    expect(r.totals.swears).toBe(1);
    expect(r.totals.prompts_with_swear).toBe(1);
    expect(r.totals.swears_per_100_prompts).toBe(50.0);
  });

  test("rate counts every swear not every prompt", () => {
    // Three swears in one prompt is 300 per 100, not 100.
    const r = buildFrom([prompt("fuck this fucking shit", "2026-08-17T10:00:00Z", "codex", "exact")]);
    expect(r.totals.swears).toBe(3);
    expect(r.totals.prompts_with_swear).toBe(1);
    expect(r.totals.swears_per_100_prompts).toBe(300.0);
  });

  // Day resolution tolerates a session-level timestamp, so these count; the
  // coverage note is what tells the reader they are dated approximately.
  test("session-precision prompts are counted, and disclosed", () => {
    const r = buildFrom([
      prompt("fuck", "2026-08-17T10:00:00Z", "cursor", "session"),
      prompt("fuck", "2026-08-17T10:00:00Z", "claude", "exact"),
    ]);
    const counted = r.daily.reduce((sum, d) => sum + d.prompts, 0);
    expect(counted).toBe(2);
    expect(r.coverage.session_precision_prompts).toBe(1);
    expect(r.coverage.notes.some((n) => n.includes("session-level"))).toBe(true);
  });

  test("days carry severity weight", () => {
    const r = buildFrom([
      prompt("fuck damn", "2026-08-17T10:00:00Z", "claude", "exact"),
      prompt("shit", "2026-08-17T10:30:00Z", "claude", "exact"),
    ]);
    expect(r.daily).toHaveLength(1);
    const [day] = r.daily;
    expect(day.prompts).toBe(2);
    expect(day.swears).toBe(3);
    // strong 10 + mild 5 + medium 8
    expect(day.weight).toBe(23);
  });

  test("top words are ranked", () => {
    const r = buildFrom([prompt("fuck fuck shit", "2026-08-17T10:00:00Z", "codex", "exact")]);
    expect(r.top_words[0].word).toBe("fuck");
    expect(r.top_words[0].count).toBe(2);
    expect(Math.abs(r.top_words[0].share - 2 / 3)).toBeLessThan(1e-9);
  });

  // The privacy guarantee: nothing a user typed may appear in the output.
  test("report never contains prompt text", () => {
    const SENTINEL = "zzsentinelzz";
    const r = buildFrom([
      prompt(`${SENTINEL} this is fucking broken`, "2026-08-17T10:00:00Z", "claude", "exact"),
    ]);
    const json = JSON.stringify(r);
    expect(json.includes(SENTINEL)).toBe(false);
    // The matched swear itself is expected; the surrounding prose is not.
    expect(json.includes("fucking")).toBe(true);
    expect(json.includes("this is")).toBe(false);
  });

  test("home directory is not a project", () => {
    const p = prompt("hi", "2026-08-17T10:00:00Z", "claude", "exact");
    p.cwd = homedir();
    const r = buildFrom([p]);
    // home dir must not leak as a project
    expect(r.projects).toHaveLength(0);
  });

  test("agent messages are counted separately", () => {
    const r = buildFrom([
      prompt("fix this fucking bug", "2026-08-17T10:00:00Z", "claude", "exact"),
      reply("damn, good catch", "2026-08-17T10:01:00Z", "claude"),
      reply("all done", "2026-08-17T10:02:00Z", "claude"),
    ]);

    // The user's headline number sees only the user's own prompt.
    expect(r.totals.prompts).toBe(1);
    expect(r.totals.swears).toBe(1);
    expect(r.totals.swears_per_100_prompts).toBe(100.0);

    expect(r.agent.messages).toBe(2);
    expect(r.agent.swears).toBe(1);
    expect(r.agent.messages_with_swear).toBe(1);
    expect(r.agent.swears_per_100_messages).toBe(50.0);

    expect(r.agent_top_words[0].word).toBe("damn");
    expect(r.top_words[0].word).toBe("fucking");
  });

  test("agent messages do not reach user-scoped sections", () => {
    const r = buildFrom([reply("damn", "2026-08-17T10:00:00Z", "claude")]);
    expect(r.totals.prompts).toBe(0);
    expect(r.totals.swears).toBe(0);
    expect(r.daily).toHaveLength(0);
    expect(r.projects).toHaveLength(0);
    expect(r.by_harness).toHaveLength(0);
    expect(r.agent.messages).toBe(1);
    expect(r.agent_by_harness[0].harness).toBe("claude");
    expect(r.agent_by_harness[0].messages).toBe(1);
  });

  test("agent daily is split by harness", () => {
    const r = buildFrom([
      reply("damn", "2026-08-17T10:00:00Z", "claude"),
      reply("all fine", "2026-08-17T11:00:00Z", "claude"),
      reply("shit", "2026-08-17T12:00:00Z", "codex"),
      reply("damn again", "2026-08-18T09:00:00Z", "claude"),
    ]);

    const row = (date: string, harness: string) => {
      const d = r.agent_daily.find((d) => d.date === date && d.harness === harness);
      if (!d) throw new Error(`missing ${date}/${harness}`);
      return d;
    };
    expect(r.agent_daily).toHaveLength(3);
    expect(row("2026-08-17", "claude").messages).toBe(2);
    expect(row("2026-08-17", "claude").swears).toBe(1);
    expect(row("2026-08-17", "codex").swears).toBe(1);
    expect(row("2026-08-18", "claude").swears).toBe(1);

    // Every agent swear lands in exactly one day/harness bucket.
    const summed = r.agent_daily.reduce((sum, d) => sum + d.swears, 0);
    expect(summed).toBe(r.agent.swears);
  });

  test("agent daily excludes user prompts", () => {
    const r = buildFrom([prompt("fuck this", "2026-08-17T10:00:00Z", "claude", "exact")]);
    expect(r.agent_daily).toHaveLength(0);
    expect(r.daily).toHaveLength(1);
  });

  test("report never contains agent text", () => {
    const SENTINEL = "zzagentzz";
    const r = buildFrom([reply(`${SENTINEL} that was damn close`, "2026-08-17T10:00:00Z", "codex")]);
    const json = JSON.stringify(r);
    expect(json.includes(SENTINEL)).toBe(false);
    expect(json.includes("damn")).toBe(true);
  });

  test("word count splits on Unicode whitespace, v1 style", () => {
    const r = buildFrom([
      // NEL splits (2 words), ZWNBSP does not (1 word).
      prompt("a\u0085b", "2026-08-17T10:00:00Z", "claude", "exact"),
      prompt("c\uFEFFd", "2026-08-17T11:00:00Z", "claude", "exact"),
    ]);
    expect(r.totals.words).toBe(3);
  });

  test("tied projects order by code point, not UTF-16 unit", () => {
    // U+FF5E sorts before U+1F4A9 byte-wise; JS `<` says the opposite.
    const a = prompt("hi", "2026-08-17T10:00:00Z", "claude", "exact");
    a.cwd = join(tmpdir(), "salt-tie", "～tools");
    const b = prompt("hi", "2026-08-17T11:00:00Z", "claude", "exact");
    b.cwd = join(tmpdir(), "salt-tie", "\u{1F4A9}app");
    const r = buildFrom([a, b]);
    expect(r.projects.map((p) => p.name)).toEqual(["～tools", "\u{1F4A9}app"]);
  });

  test("non-canonical home spellings are not projects", () => {
    const home = homedir().replace(/\/+$/, "");
    const segs = home.split("/").filter((s) => s !== "");
    expect(projectName(`${home}/.`)).toBeNull();
    expect(projectName(`${home}//`)).toBeNull();
    expect(projectName(`/${segs.join("//")}`)).toBeNull();
    expect(projectName(`/${segs.join("/./")}`)).toBeNull();
  });

  test("project name comes from normalized components", () => {
    const dir = mkdtempSync(join(tmpdir(), "salt-report-"));
    try {
      mkdirSync(join(dir, "repo", ".git"), { recursive: true });
      expect(projectName(`${join(dir, "repo")}/.`)).toBe("repo");
      expect(projectName(`${dir}//repo`)).toBe("repo");
      // With no .git in reach the leaf directory wins, `.` normalized away.
      expect(projectName("/nonexistent-salt/leaf/.")).toBe("leaf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("project name is basename only", () => {
    const r = buildFrom([prompt("hi", "2026-08-17T10:00:00Z", "claude", "exact")]);
    expect(r.projects[0].name).toBe("proj");
    const json = JSON.stringify(r);
    // absolute path must not leak
    expect(json.includes("/tmp/proj")).toBe(false);
  });
});
