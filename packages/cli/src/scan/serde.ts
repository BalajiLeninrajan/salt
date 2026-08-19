// Field decoders mirroring serde's strictness.
//
// v1 deserialized every log line into typed structs, so one present-but-wrong-
// typed field rejected the whole record — `#[serde(default)]` only covers
// missing fields. Coercing per-field instead would keep lines v1 dropped and
// shift every downstream count.

export const INVALID: unique symbol = Symbol("invalid");

/** `#[serde(default)] String`: missing means `""`, anything but a string fails. */
export function defString(v: unknown): string | typeof INVALID {
  if (v === undefined) return "";
  return typeof v === "string" ? v : INVALID;
}

/** `#[serde(default)] Option<String>`: missing and null both mean absent. */
export function optString(v: unknown): string | undefined | typeof INVALID {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : INVALID;
}

/** `#[serde(default)] bool`: missing means false; null is not a bool. */
export function defBool(v: unknown): boolean | typeof INVALID {
  if (v === undefined) return false;
  return typeof v === "boolean" ? v : INVALID;
}

const I64_MIN = -(2 ** 63);
const I64_MAX = 2 ** 63; // exclusive: 2^63 itself overflows i64

/**
 * `#[serde(default)] Option<i64>`: fractions and out-of-range numbers fail.
 * (JSON.parse erases the written form, so `1e18` — a float to serde_json,
 * rejecting the record — is indistinguishable from its integer spelling here.)
 */
export function optI64(v: unknown): number | undefined | typeof INVALID {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < I64_MIN || v >= I64_MAX) return INVALID;
  return v;
}

export interface Block {
  type: string;
  text: string | undefined;
}

/** The untagged `Content` enum: `Text(String) | Blocks(Vec<Block>) | Absent`. */
export type Content = string | Block[] | undefined;

export function decodeContent(v: unknown): Content | typeof INVALID {
  if (v === undefined || v === null) return undefined; // Absent
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return INVALID;
  const blocks: Block[] = [];
  for (const b of v) {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return INVALID;
    const o = b as Record<string, unknown>;
    const type = defString(o.type);
    const text = optString(o.text);
    if (type === INVALID || text === INVALID) return INVALID;
    blocks.push({ type, text });
  }
  return blocks;
}

/** Joins the `text` blocks the way both v1 parsers did. */
export function joinTextBlocks(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text !== undefined)
    .map((b) => b.text as string)
    .join("\n");
}
