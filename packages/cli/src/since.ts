// Parsing for `--since`.

const DAY_MS = 86_400_000;

/**
 * Accepts either an RFC-3339-ish date (`2026-01-01`) or a span (`30d`, `12w`).
 * Returns ms since epoch.
 */
export function parseSince(raw: string): number {
  const t = raw.trim();
  const unit = t.slice(-1);
  if (unit === "d" || unit === "w" || unit === "m" || unit === "y") {
    const rest = t.slice(0, -1);
    if (!/^-?\d+$/.test(rest)) throw new Error(`invalid span: ${t}`);
    const n = parseInt(rest, 10);
    const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return Date.now() - days * DAY_MS;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(year, month - 1, day);
    // Date.UTC rolls invalid dates over (2026-02-31 → March 3rd); a
    // round-trip check rejects anything that is not a real calendar date.
    const d = new Date(ms);
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) {
      return ms;
    }
  }
  throw new Error(`invalid date: ${t} (expected YYYY-MM-DD or a span like 30d)`);
}
