// Rust-parity text primitives.
//
// JS `\s` and `String.trim` use the ECMAScript WhiteSpace class, which
// includes U+FEFF and excludes U+0085 (NEL); Rust's `char::is_whitespace` is
// the Unicode `White_Space` property — the exact opposite on both. v1 split
// and trimmed with the Rust class, so token boundaries must too.

const WS = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";

const SPLIT = new RegExp(`[${WS}]+`);
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const TRIM_START = new RegExp(`^[${WS}]+`);

/** `str::split_whitespace`: splits on Unicode whitespace, no empty tokens. */
export function splitWhitespace(s: string): string[] {
  return s.split(SPLIT).filter((t) => t.length > 0);
}

/** `str::trim`. */
export function trimWhitespace(s: string): string {
  return s.replace(TRIM, "");
}

/** `str::trim_start`. */
export function trimStartWhitespace(s: string): string {
  return s.replace(TRIM_START, "");
}

/**
 * Code-point order — how Rust compares `str`s (UTF-8 byte order). JS `<`
 * compares UTF-16 units instead, which misorders U+E000..U+FFFF against
 * supplementary-plane characters.
 */
export function cmpCodePoints(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(i)!;
    if (ca !== cb) return ca - cb;
    i += ca >= 0x10000 ? 2 : 1;
  }
  return a.length - b.length;
}
