// Codex rollout parser.
//
// Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
// `~/.codex/archived_sessions/`, as a wrapped event log. Human turns arrive as
// `event_msg` / `user_message`, but Codex also injects synthetic turns through
// that same channel (`<codex_delegation>`, `<in-app-browser-context>`,
// `<recommended_plugins>`), so the stripper does the real filtering.
//
// The agent's side arrives as `event_msg` / `agent_message`. Both roles are
// mirrored into `response_item` with extra plumbing; taking the `event_msg`
// channel for both is what keeps them from being counted twice.

import type { Message } from "../types.js";
import { strip } from "./strip.js";
import { type LineGate, forEachLine } from "./lines.js";
import { INVALID, defString, optString } from "./serde.js";

/**
 * Cheap byte gate applied to the raw line before it is even decoded, let alone
 * JSON-parsed. Every line we care about contains one of these; a sampled
 * rollout held 1,841 `token_count` events against 20 `user_message`.
 */
const LINE_GATE: LineGate = {
  // Contained in all three needles, so it never hides a line they would match.
  probe: Buffer.from("_m", "utf8"),
  needles: ['"user_message"', '"agent_message"', '"session_meta"'].map((s) =>
    Buffer.from(s, "utf8"),
  ),
};

interface Line {
  type: string;
  timestamp: string | undefined;
  payload: Payload | undefined;
}

interface Payload {
  type: string;
  message: string | undefined;
  cwd: string | undefined;
  session_id: string | undefined;
}

/** One mistyped field rejects the whole line, as v1's typed structs did. */
function decodeLine(v: unknown): Line | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const type = defString(o.type);
  const timestamp = optString(o.timestamp);
  const payload = decodePayload(o.payload);
  if (type === INVALID || timestamp === INVALID || payload === INVALID) return null;
  return { type, timestamp, payload };
}

function decodePayload(v: unknown): Payload | undefined | typeof INVALID {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return INVALID;
  const o = v as Record<string, unknown>;
  const type = defString(o.type);
  const message = optString(o.message);
  const cwd = optString(o.cwd);
  const session_id = optString(o.session_id);
  if (type === INVALID || message === INVALID || cwd === INVALID || session_id === INVALID) {
    return INVALID;
  }
  return { type, message, cwd, session_id };
}

/**
 * Parses one rollout. Session metadata comes from the first `session_meta`
 * line; later ones are forks and are ignored so a file maps to one session.
 */
export async function parseFile(path: string): Promise<Message[]> {
  let cwd: string | undefined;
  let sessionId = "";
  let seenMeta = false;
  const out: Message[] = [];

  await forEachLine(path, (line) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = decodeLine(json);
    if (parsed === null) return;
    const payload = parsed.payload;
    if (payload === undefined) return;

    if (parsed.type === "session_meta") {
      if (seenMeta) return;
      seenMeta = true;
      cwd = payload.cwd;
      sessionId = payload.session_id ?? "";
      return;
    }

    if (parsed.type !== "event_msg") return;
    const kind = payload.type;
    if (kind !== "user_message" && kind !== "agent_message") return;
    if (payload.message === undefined) return;

    const text = strip(payload.message);
    if (text === null) return;
    if (parsed.timestamp === undefined) return;
    const ts = Date.parse(parsed.timestamp);
    if (Number.isNaN(ts)) return;

    out.push({
      harness: "codex",
      role: kind === "user_message" ? "user" : "agent",
      ts,
      tsPrecision: "exact",
      cwd,
      sessionId,
      text,
    });
  }, LINE_GATE);

  return out;
}
