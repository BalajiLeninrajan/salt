// Claude Code session parser.
//
// Sessions live at `~/.claude/projects/<slug>/<session-uuid>.jsonl`, one JSON
// object per line. The overwhelming majority of `type: "user"` lines are tool
// results, not human turns. `type: "assistant"` lines carry the agent's side;
// their content mixes `thinking`, `tool_use`, and `text` blocks, and only
// `text` counts: it is what the agent actually said, as opposed to what it
// thought or ran.

import type { Message, Role } from "../types.js";
import { trimStartWhitespace, trimWhitespace } from "../text.js";
import { strip } from "./strip.js";
import { forEachLine } from "./lines.js";
import {
  INVALID,
  type Content,
  decodeContent,
  defBool,
  defString,
  joinTextBlocks,
  optString,
} from "./serde.js";

/**
 * Legacy sessions predate the `origin` field; these prefixes mark the
 * machine-generated turns we would otherwise have to guess at.
 */
const LEGACY_REJECT_PREFIXES = [
  "<command-message>",
  "<command-name>",
  "<local-command-",
  "<task-notification>",
  "<system-reminder>",
];

interface Line {
  type: string;
  message: { content: Content } | undefined;
  origin: { kind: string } | undefined;
  isSidechain: boolean;
  isMeta: boolean;
  isCompactSummary: boolean;
  timestamp: string | undefined;
  cwd: string | undefined;
  sessionId: string | undefined;
}

/** One mistyped field rejects the whole line, as v1's typed structs did. */
function decodeLine(v: unknown): Line | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;

  const type = defString(o.type);
  const message = decodeBody(o.message);
  const origin = decodeOrigin(o.origin);
  const isSidechain = defBool(o.isSidechain);
  const isMeta = defBool(o.isMeta);
  const isCompactSummary = defBool(o.isCompactSummary);
  const timestamp = optString(o.timestamp);
  const cwd = optString(o.cwd);
  const sessionId = optString(o.sessionId);

  if (
    type === INVALID ||
    message === INVALID ||
    origin === INVALID ||
    isSidechain === INVALID ||
    isMeta === INVALID ||
    isCompactSummary === INVALID ||
    timestamp === INVALID ||
    cwd === INVALID ||
    sessionId === INVALID
  ) {
    return null;
  }
  return {
    type,
    message,
    origin,
    isSidechain,
    isMeta,
    isCompactSummary,
    timestamp,
    cwd,
    sessionId,
  };
}

function decodeBody(v: unknown): { content: Content } | undefined | typeof INVALID {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return INVALID;
  const content = decodeContent((v as Record<string, unknown>).content);
  return content === INVALID ? INVALID : { content };
}

function decodeOrigin(v: unknown): { kind: string } | undefined | typeof INVALID {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return INVALID;
  const kind = defString((v as Record<string, unknown>).kind);
  return kind === INVALID ? INVALID : { kind };
}

export function parseLine(line: string): Message | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = decodeLine(json);
  if (parsed === null) return null;
  // Sidechains are sub-agent traffic: their "user" turns are written by the
  // main agent, and their replies never reach the person at the keyboard.
  // Excluding both sides keeps the user and agent counts comparable.
  if (parsed.isSidechain || parsed.isMeta || parsed.isCompactSummary) return null;

  switch (parsed.type) {
    case "user":
      return parseUser(parsed);
    case "assistant":
      return parseAssistant(parsed);
    default:
      return null;
  }
}

function parseAssistant(parsed: Line): Message | null {
  // Only `text` blocks. `thinking` is the agent talking to itself and
  // `tool_use` is machinery, neither of which is the agent's reply.
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return null;
  return finish(joinTextBlocks(content), "agent", parsed);
}

function parseUser(parsed: Line): Message | null {
  const message = parsed.message;
  if (message === undefined) return null;
  const content = message.content;

  let raw: string;
  if (parsed.origin !== undefined) {
    // Modern sessions: `origin.kind` is the authorship field, and it is the
    // whole test. `promptSource` records the transport the prompt arrived on
    // (`typed`, `queued`, `sdk`) and says nothing about who wrote it — the
    // desktop app stamps `sdk` on human turns and task notifications alike.
    // Gating on it dropped every desktop session.
    if (parsed.origin.kind !== "human") return null;
    const text = contentText(content);
    if (text === null) return null;
    raw = text;
  } else if (typeof content === "string") {
    // Legacy sessions: string content only. Array content without an
    // `origin` is always a tool result.
    const t = trimStartWhitespace(content);
    if (LEGACY_REJECT_PREFIXES.some((p) => t.startsWith(p))) return null;
    raw = content;
  } else {
    return null;
  }

  return finish(raw, "user", parsed);
}

/**
 * Strips ambient text and timestamps a message. Returns null when nothing
 * survives stripping, which is how turns that were purely code or injected
 * context drop out.
 */
function finish(raw: string, role: Role, parsed: Line): Message | null {
  const text = strip(raw);
  if (text === null) return null;
  if (parsed.timestamp === undefined) return null;
  const ts = Date.parse(parsed.timestamp);
  if (Number.isNaN(ts)) return null;

  return {
    harness: "claude",
    role,
    ts,
    tsPrecision: "exact",
    cwd: parsed.cwd,
    sessionId: parsed.sessionId ?? "",
    text,
  };
}

/**
 * Human turns can carry attachments, so content may be an array even when
 * typed. Concatenate the text blocks and ignore images.
 */
function contentText(content: Content): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = joinTextBlocks(content);
    return trimWhitespace(joined).length === 0 ? null : joined;
  }
  return null;
}

export async function parseFile(path: string): Promise<Message[]> {
  const out: Message[] = [];
  await forEachLine(path, (line) => {
    const m = parseLine(line);
    if (m) out.push(m);
  });
  return out;
}
