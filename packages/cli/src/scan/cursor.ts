// Cursor chat parser.
//
// Chats live at `~/.cursor/chats/<workspace-hash>/<chat-uuid>/store.db`, a
// SQLite file whose `blobs` table mixes protobuf records with a plain-JSON
// mirror of every message. Only the JSON ones are needed, so no protobuf
// schema is required.
//
// Typed prompts are wrapped in `<user_query>`. The ambient `<user_info>` block
// is also `role: user` but carries no wrapper, which is exactly what
// distinguishes them.
//
// Cursor stores no per-message timestamp, so prompts inherit the chat's time
// and are marked session-precision.

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Message } from "../types.js";
import { trimStartWhitespace, trimWhitespace } from "../text.js";
import { strip } from "./strip.js";
import { readBlobs } from "../db.js";
import {
  INVALID,
  type Content,
  decodeContent,
  defString,
  joinTextBlocks,
  optI64,
  optString,
} from "./serde.js";

interface Blob {
  role: string;
  content: Content;
}

/** One mistyped field rejects the whole blob, as v1's typed structs did. */
function decodeBlob(v: unknown): Blob | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const role = defString(o.role);
  const content = decodeContent(o.content);
  if (role === INVALID || content === INVALID) return null;
  return { role, content };
}

interface Meta {
  createdAtMs?: number;
  updatedAtMs?: number;
  cwd?: string;
}

export async function parseDb(path: string): Promise<Message[]> {
  const meta = readMeta(path);
  const { ts, tsPrecision } = sessionTime(path, meta);
  const sessionId = basename(dirname(path));

  const rows = await readBlobs(path);

  const out: Message[] = [];
  let cwd = meta.cwd;
  // Fatal so invalid UTF-8 skips the blob, exactly as serde_json rejected it.
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const data of rows) {
    // Protobuf blobs are the majority; JSON ones start with '{'.
    let text: string;
    if (typeof data === "string") {
      if (!data.startsWith("{")) continue;
      text = data;
    } else if (data instanceof Uint8Array) {
      if (data[0] !== 0x7b) continue;
      try {
        text = decoder.decode(data);
      } catch {
        continue;
      }
    } else {
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const blob = decodeBlob(json);
    if (blob === null) continue;
    const raw = contentText(blob.content);

    let role: Message["role"];
    let body: string;
    if (blob.role === "user") {
      if (cwd === undefined) cwd = workspacePathFromUserInfo(raw);
      // The `<user_query>` wrapper is what separates a typed prompt from the
      // ambient `<user_info>` block, which is also `role: user`.
      const inner = extractUserQuery(raw);
      if (inner === null) continue;
      role = "user";
      body = inner;
    } else if (blob.role === "assistant") {
      role = "agent";
      body = raw;
    } else {
      continue;
    }

    const stripped = strip(body);
    if (stripped === null) continue;
    out.push({
      harness: "cursor",
      role,
      ts,
      tsPrecision,
      cwd,
      sessionId,
      text: stripped,
    });
  }
  return out;
}

function contentText(content: Content): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return joinTextBlocks(content);
  return "";
}

/**
 * The `<user_query>` wrapper is the discriminator between a typed prompt and
 * the ambient `<user_info>` block that shares its role.
 */
function extractUserQuery(raw: string): string | null {
  const open = raw.indexOf("<user_query>");
  if (open === -1) return null;
  const start = open + "<user_query>".length;
  const end = raw.indexOf("</user_query>", start);
  if (end === -1) return null;
  return raw.slice(start, end);
}

function workspacePathFromUserInfo(raw: string): string | undefined {
  const line = raw
    .split("\n")
    .find((l) => trimStartWhitespace(l).startsWith("Workspace Path:"));
  if (!line) return undefined;
  const value = trimWhitespace(
    line.slice(line.indexOf("Workspace Path:") + "Workspace Path:".length),
  );
  return value.length > 0 ? value : undefined;
}

function readMeta(db: string): Meta {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dirname(db), "meta.json"), "utf8"));
  } catch {
    return {};
  }
  // All-or-nothing, like serde: one bad field discards the whole Meta, the
  // valid `cwd` next to it included.
  return decodeMeta(json) ?? {};
}

function decodeMeta(v: unknown): Meta | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const createdAtMs = optI64(o.createdAtMs);
  const updatedAtMs = optI64(o.updatedAtMs);
  const cwd = optString(o.cwd);
  if (createdAtMs === INVALID || updatedAtMs === INVALID || cwd === INVALID) return null;
  return { createdAtMs, updatedAtMs, cwd };
}

// The range `chrono::DateTime::from_timestamp_millis` accepts; outside it v1
// fell back to the file mtime.
const CHRONO_MIN_MS = -8334601228800000;
const CHRONO_MAX_MS = 8210266876799999;

function sessionTime(db: string, meta: Meta): { ts: number; tsPrecision: "session" } {
  const ms = meta.updatedAtMs ?? meta.createdAtMs;
  if (ms !== undefined && ms >= CHRONO_MIN_MS && ms <= CHRONO_MAX_MS) {
    return { ts: ms, tsPrecision: "session" };
  }
  try {
    return { ts: statSync(db).mtimeMs, tsPrecision: "session" };
  } catch {
    return { ts: Date.now(), tsPrecision: "session" };
  }
}
