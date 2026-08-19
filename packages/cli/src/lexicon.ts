// User overrides for the profanity lexicon.
//
// Nobody should have to fork the binary to fix a false positive, so the
// matcher is configurable at `~/.config/salt/lexicon.toml`:
//
// ```toml
// remove = ["hell"]            # stop counting these
// allow  = ["cassowary"]       # innocent words to never match inside
//
// [add]
// blast = "mild"               # word = tier
// ```

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { Tier } from "@salt/core";
import { trimWhitespace } from "./text.js";

export interface Overrides {
  add: Record<string, string>;
  remove: string[];
  allow: string[];
}

const empty = (): Overrides => ({ add: {}, remove: [], allow: [] });

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Parsed additions, ignoring entries with an unknown tier. */
export function additions(overrides: Overrides): [string, Tier][] {
  const out: [string, Tier][] = [];
  for (const [word, tier] of Object.entries(overrides.add)) {
    const parsed = parseTier(tier);
    if (parsed) out.push([asciiLower(word), parsed]);
  }
  return out;
}

function parseTier(s: string): Tier | null {
  // v1 trimmed with `str::trim` and lowercased ASCII-only.
  const t = asciiLower(trimWhitespace(s));
  if (t === "mild" || t === "medium" || t === "strong" || t === "acronym") return t;
  return null;
}

export function defaultPath(): string {
  return join(homedir(), ".config/salt/lexicon.toml");
}

/** Rejects anything serde would have: wrong-typed fields are a parse error. */
function shape(parsed: Record<string, unknown>): Overrides | null {
  const out = empty();
  if (parsed.add !== undefined) {
    if (typeof parsed.add !== "object" || parsed.add === null || Array.isArray(parsed.add)) {
      return null;
    }
    for (const [word, tier] of Object.entries(parsed.add)) {
      if (typeof tier !== "string") return null;
      out.add[word] = tier;
    }
  }
  for (const key of ["remove", "allow"] as const) {
    const list = parsed[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) return null;
    out[key] = list as string[];
  }
  return out;
}

/**
 * Loads overrides from `path`. A missing default file is not an error; a
 * malformed one is, because silently ignoring it would produce a wrong report.
 */
export function loadOverrides(path?: string): Overrides {
  const explicit = path !== undefined;
  const p = path ?? defaultPath();

  let body: string;
  try {
    body = readFileSync(p, "utf8");
  } catch (e) {
    if (!explicit && (e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw new Error(`could not read lexicon at ${p}`);
  }

  let overrides: Overrides | null;
  try {
    overrides = shape(parse(body));
  } catch {
    overrides = null;
  }
  if (!overrides) throw new Error(`could not parse lexicon at ${p}`);
  return overrides;
}
