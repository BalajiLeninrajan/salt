export type Harness = "claude" | "codex" | "cursor";
export type Role = "user" | "agent";

/**
 * How much we trust a message's timestamp. Cursor stores no per-message time,
 * so every prompt in a chat inherits the session's time; the heatmap excludes
 * those.
 */
export type TsPrecision = "exact" | "session";

/**
 * A single message, after ambient text has been stripped.
 *
 * `text` is transient: it reaches the profanity matcher and is dropped. It is
 * never serialised, cached, or sent anywhere.
 */
export interface Message {
  harness: Harness;
  role: Role;
  /** ms since epoch, UTC. */
  ts: number;
  tsPrecision: TsPrecision;
  cwd?: string;
  sessionId: string;
  text: string;
}

export interface ScanStats {
  files_scanned: number;
  files_failed: number;
  bytes_scanned: number;
  duplicates_dropped: number;
}

export const ALL_HARNESSES: Harness[] = ["claude", "codex", "cursor"];

export function parseHarness(s: string): Harness {
  const t = s.trim().toLowerCase();
  if (t === "claude" || t === "codex" || t === "cursor") return t;
  throw new UsageError(`unknown harness: ${t}`);
}

/** Argument-shaped mistakes exit 2; everything else exits 1. */
export class UsageError extends Error {}
