import { describe, expect, test } from "bun:test";

import { parseLine } from "../src/scan/claude.js";

describe("scan/claude", () => {
  test("keeps typed human turn", () => {
    const line = `{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"this is broken"},"timestamp":"2026-08-17T21:33:43.823Z","cwd":"/tmp/x","sessionId":"s1"}`;
    const p = parseLine(line);
    expect(p).not.toBeNull();
    expect(p!.text).toBe("this is broken");
    expect(p!.sessionId).toBe("s1");
    expect(p!.tsPrecision).toBe("exact");
  });

  test("keeps queued human turn", () => {
    const line = `{"type":"user","origin":{"kind":"human"},"promptSource":"queued","message":{"role":"user","content":"why plain js"},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)).not.toBeNull();
  });

  test("drops tool result", () => {
    const line = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"command not found"}]},"timestamp":"2026-08-17T21:33:49.456Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("drops task notification", () => {
    const line = `{"type":"user","origin":{"kind":"task-notification"},"promptSource":"system","message":{"role":"user","content":"<task-notification>done</task-notification>"},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("drops sdk origin", () => {
    const line = `{"type":"user","origin":{"kind":"human"},"promptSource":"sdk","message":{"role":"user","content":"hi"},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("drops sidechain", () => {
    const line = `{"type":"user","isSidechain":true,"origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"sub agent"},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("legacy string turn is kept", () => {
    const line = `{"type":"user","message":{"role":"user","content":"make it work"},"timestamp":"2026-05-17T21:33:43.823Z"}`;
    expect(parseLine(line)!.text).toBe("make it work");
  });

  test("legacy slash command is dropped", () => {
    const line = `{"type":"user","message":{"role":"user","content":"<command-message>catppuccin-neu</command-message>\\n<command-name>/catppuccin-neu</command-name>"},"timestamp":"2026-05-17T21:33:43.823Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("array content human turn is kept", () => {
    const line = `{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image","source":{}}]},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)!.text).toBe("look at this");
  });

  test("keeps assistant text block", () => {
    const line = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"that was damn close"}]},"timestamp":"2026-08-17T21:33:44.000Z","sessionId":"s1"}`;
    const m = parseLine(line);
    expect(m).not.toBeNull();
    expect(m!.role).toBe("agent");
    expect(m!.text).toBe("that was damn close");
  });

  test("drops assistant thinking and tool use", () => {
    const line = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"this is damn hard","signature":"x"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-08-17T21:33:44.000Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("drops compact summary", () => {
    // Compaction summaries quote the user's own prompts back verbatim, so
    // counting them would attribute the user's swearing to the agent.
    const line = `{"type":"assistant","isCompactSummary":true,"message":{"role":"assistant","content":[{"type":"text","text":"The user said this is fucking broken"}]},"timestamp":"2026-08-17T21:33:44.000Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("drops sidechain assistant turn", () => {
    const line = `{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"damn ok"}]},"timestamp":"2026-08-17T21:33:44.000Z"}`;
    expect(parseLine(line)).toBeNull();
  });

  test("user turns are tagged as user", () => {
    const line = `{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"hello there"},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)!.role).toBe("user");
  });

  test("one mistyped field rejects the whole line", () => {
    // v1 deserialized each line into typed structs, so a bad sibling field
    // dropped the line wholesale rather than being coerced around.
    const cases = [
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},42]},"timestamp":"2026-08-17T21:33:44.000Z"}`,
      `{"type":"user","isMeta":null,"message":{"role":"user","content":"hello"},"timestamp":"2026-08-17T21:33:43.823Z"}`,
      `{"type":"user","cwd":5,"message":{"role":"user","content":"hello"},"timestamp":"2026-08-17T21:33:43.823Z"}`,
      `{"type":"assistant","origin":"weird","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-17T21:33:44.000Z"}`,
    ];
    for (const line of cases) expect(parseLine(line)).toBeNull();
  });

  test("turn that is only code is dropped", () => {
    const line = `{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"\`\`\`\\nassert!(x);\\n\`\`\`"},"timestamp":"2026-08-17T21:33:43.823Z"}`;
    expect(parseLine(line)).toBeNull();
  });
});
