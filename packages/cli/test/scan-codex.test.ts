import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFile } from "../src/scan/codex.js";
import type { Message } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "salt-codex-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function parseStr(body: string): Promise<Message[]> {
  const path = join(dir, `rollout-${n++}.jsonl`);
  writeFileSync(path, body);
  return parseFile(path);
}

const META = `{"timestamp":"2026-08-01T08:14:04.658Z","type":"session_meta","payload":{"session_id":"s1","cwd":"/tmp/proj"}}`;

describe("scan/codex", () => {
  test("keeps real user message and takes session meta", async () => {
    const body = `${META}\n{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"this is broken"}}\n`;
    const got = await parseStr(body);
    expect(got.length).toBe(1);
    expect(got[0]!.text).toBe("this is broken");
    expect(got[0]!.cwd).toBe("/tmp/proj");
    expect(got[0]!.sessionId).toBe("s1");
  });

  test("drops delegation injection", async () => {
    const body = `${META}\n{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"<codex_delegation>\\n  <input>go</input>\\n</codex_delegation>"}}\n`;
    expect(await parseStr(body)).toEqual([]);
  });

  test("drops ambient browser context", async () => {
    const body = `${META}\n{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"\\n<in-app-browser-context source=\\"ambient-ui-state\\">\\nstuff\\n</in-app-browser-context>"}}\n`;
    expect(await parseStr(body)).toEqual([]);
  });

  test("ignores noise events", async () => {
    const body =
      `${META}\n` +
      `{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{}}}\n` +
      `{"timestamp":"2026-08-01T08:15:01.000Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"damn this is hard"}}\n`;
    expect(await parseStr(body)).toEqual([]);
  });

  test("does not double count response_item mirror", async () => {
    const body =
      `${META}\n` +
      `{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"fix it"}}\n` +
      `{"timestamp":"2026-08-01T08:15:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix it"}]}}\n`;
    expect((await parseStr(body)).length).toBe(1);
  });

  test("keeps agent message", async () => {
    const body = `${META}\n{"timestamp":"2026-08-01T08:15:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"that was damn close"}}\n`;
    const got = await parseStr(body);
    expect(got.length).toBe(1);
    expect(got[0]!.role).toBe("agent");
    expect(got[0]!.text).toBe("that was damn close");
  });

  test("tags each role and ignores the assistant mirror", async () => {
    const body =
      `${META}\n` +
      `{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"fix it"}}\n` +
      `{"timestamp":"2026-08-01T08:15:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done, damn that was subtle"}}\n` +
      `{"timestamp":"2026-08-01T08:15:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done, damn that was subtle"}]}}\n`;
    const got = await parseStr(body);
    // response_item mirror must not be counted
    expect(got.length).toBe(2);
    expect(got[0]!.role).toBe("user");
    expect(got[1]!.role).toBe("agent");
  });

  test("drops agent reasoning", async () => {
    const body = `${META}\n{"timestamp":"2026-08-01T08:15:01.000Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"damn this is hard"}}\n`;
    expect(await parseStr(body)).toEqual([]);
  });

  test("malformed session meta is skipped, not consumed", async () => {
    // A mistyped field fails the whole line as serde did, so the next valid
    // session_meta is the one that wins.
    for (const bad of [
      `{"timestamp":"2026-08-01T08:14:04.658Z","type":"session_meta","payload":{"session_id":"first","cwd":123}}`,
      `{"timestamp":123,"type":"session_meta","payload":{"session_id":"first","cwd":"/first"}}`,
    ]) {
      const body =
        `${bad}\n` +
        `{"timestamp":"2026-08-01T08:14:05.000Z","type":"session_meta","payload":{"session_id":"second","cwd":"/second"}}\n` +
        `{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}\n`;
      const got = await parseStr(body);
      expect(got[0]!.sessionId).toBe("second");
      expect(got[0]!.cwd).toBe("/second");
    }
  });

  test("first session meta wins over fork", async () => {
    const body =
      `${META}\n` +
      `{"timestamp":"2026-08-01T08:14:05.000Z","type":"session_meta","payload":{"session_id":"s2","cwd":"/tmp/other"}}\n` +
      `{"timestamp":"2026-08-01T08:15:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello there"}}\n`;
    const got = await parseStr(body);
    expect(got[0]!.sessionId).toBe("s1");
    expect(got[0]!.cwd).toBe("/tmp/proj");
  });
});
