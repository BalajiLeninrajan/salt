// Tiered profanity matching.
//
// Accuracy here is what the whole tool rests on. Two failure modes matter, and
// they pull in opposite directions:
//
// * **False positives.** These prompts are saturated with code and technical
//   English. `assert`, `class`, `pass`, `analysis`, and `Scunthorpe` all embed
//   swear substrings. Word boundaries plus an explicit allowlist handle this;
//   the stripper having already removed code does most of the work.
// * **Evasion.** People write `f*ck`, `sh1t`, `fck`. Normalisation folds those
//   onto their canonical spelling before matching.

import type { Tier } from "@salt/core";

/**
 * Canonical lexicon. Inflections are handled by suffix matching, not by
 * listing every form.
 */
const LEXICON: [string, Tier][] = [
  // mild
  ["damn", "mild"],
  ["damnit", "mild"],
  ["dammit", "mild"],
  ["hell", "mild"],
  ["crap", "mild"],
  ["sucks", "mild"],
  ["suck", "mild"],
  ["screwed", "mild"],
  ["goddamn", "mild"],
  ["stupid", "mild"],
  ["dumb", "mild"],
  ["clueless", "mild"],
  // medium
  ["shit", "medium"],
  ["bullshit", "medium"],
  ["ass", "medium"],
  ["arse", "medium"],
  ["asshole", "medium"],
  ["dumbass", "medium"],
  ["bitch", "medium"],
  ["dick", "medium"],
  ["piss", "medium"],
  ["pissed", "medium"],
  ["bastard", "medium"],
  ["bollocks", "medium"],
  ["wanker", "medium"],
  ["prick", "medium"],
  ["douche", "medium"],
  ["idiot", "medium"],
  ["idiotic", "medium"],
  ["moron", "medium"],
  ["moronic", "medium"],
  ["imbecile", "medium"],
  ["jackass", "medium"],
  ["dimwit", "medium"],
  ["nitwit", "medium"],
  ["halfwit", "medium"],
  ["braindead", "medium"],
  ["incompetent", "medium"],
  ["pathetic", "medium"],
  // strong
  ["fuck", "strong"],
  ["fucking", "strong"],
  ["fucked", "strong"],
  ["fucker", "strong"],
  ["clusterfuck", "strong"],
  ["motherfucker", "strong"],
  ["cunt", "strong"],
  ["retard", "strong"],
  ["retarded", "strong"],
  ["dumbfuck", "strong"],
  ["dumbshit", "strong"],
  ["dipshit", "strong"],
  ["shithead", "strong"],
  // acronym
  ["wtf", "acronym"],
  ["ffs", "acronym"],
  ["stfu", "acronym"],
  ["omfg", "acronym"],
  ["gtfo", "acronym"],
  ["af", "acronym"],
  ["smfh", "acronym"],
];

/**
 * Words that contain a lexicon entry as a substring but are innocent.
 *
 * Matching is word-bounded, so this only needs to cover whole words that *are*
 * a swear plus affixes — the Scunthorpe class. Every entry here was observed
 * in, or is plausible for, real coding prompts.
 */
const ALLOWLIST: string[] = [
  "assert",
  "asserts",
  "asserted",
  "assertion",
  "assertions",
  "assign",
  "assigns",
  "assigned",
  "assignment",
  "assignments",
  "asset",
  "assets",
  "associate",
  "associated",
  "association",
  "assume",
  "assumes",
  "assumed",
  "assumption",
  "assumptions",
  "assure",
  "async",
  "class",
  "classes",
  "classname",
  "pass",
  "passed",
  "passes",
  "passing",
  "password",
  "passwords",
  "bypass",
  "compass",
  "bass",
  "brass",
  "glass",
  "grass",
  "mass",
  "massive",
  "massively",
  "cassandra",
  "embassy",
  "hello",
  "shell",
  "shells",
  "shelling",
  "michelle",
  "analysis",
  "analyse",
  "analyze",
  "scunthorpe",
  "dickinson",
  "sussex",
  "essex",
  "middlesex",
  "canvas",
  "harass",
  "harassment",
  "surpass",
  "assembly",
  "assembler",
  "cassette",
  "molasses",
  "potassium",
  "assist",
  "assistant",
  "access",
  "processed",
  "oxymoron",
  "dumbbell",
  "dumbbells",
  "retardant",
  "retardants",
];

/** A single confirmed hit. */
export interface Hit {
  /** Canonical lexicon entry. */
  word: string;
  tier: Tier;
  /**
   * The whole word the match sat inside, as written.
   *
   * Kept for auditing precision: it distinguishes a real `hell` from a
   * missed `hellscape` without exposing any surrounding prompt text.
   */
  surface: string;
}

export interface Overrides {
  add: [string, Tier][];
  remove: string[];
  allow: string[];
}

/**
 * Folds case, leetspeak, and censor characters onto canonical spellings so
 * `F*ck`, `sh1t`, and `FUCK` all reach the lexicon.
 */
export function normalise(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch >= "A" && ch <= "Z" ? String.fromCharCode(ch.charCodeAt(0) + 32) : ch;
    switch (c) {
      case "4":
      case "@":
        out += "a";
        break;
      case "3":
        out += "e";
        break;
      case "1":
      case "!":
        out += "i";
        break;
      case "0":
        out += "o";
        break;
      case "$":
      case "5":
        out += "s";
        break;
      case "7":
        out += "t";
        break;
      // Censor characters stand in for the vowel they hide.
      // TODO: folding both to `u` means `f*ck` matches but `sh*t` becomes
      // `shut` and does not; kept as-is to stay faithful to v1.
      case "*":
      case "#":
        out += "u";
        break;
      default:
        out += c;
    }
  }
  return out;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function isWordChar(c: string): boolean {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    c === "_" ||
    c === "'"
  );
}

/**
 * A match counts only when the lexicon word is not glued to more letters,
 * except for a small set of grammatical suffixes.
 */
const SUFFIXES = [
  "s", "es", "ed", "ing", "y", "er", "ers", "in", "in'", "ty", "tier", "head",
  "hole", "holes", "face", "wit", "ly", "ness",
];

function isWordBoundary(text: string, start: number, end: number): boolean {
  const leftOk = start === 0 || !isWordChar(text[start - 1]);
  if (!leftOk) return false;
  if (end >= text.length || !isWordChar(text[end])) return true;
  // Allow inflections: fucking, shitty, asses, damned.
  const tail = text.slice(end);
  return SUFFIXES.some(
    (suf) => tail.startsWith(suf) && (tail.length === suf.length || !isWordChar(tail[suf.length])),
  );
}

/** Expands a match to the whole surrounding word, for allowlist comparison. */
function wholeWord(text: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && isWordChar(text[s - 1])) s -= 1;
  let e = end;
  while (e < text.length && isWordChar(text[e])) e += 1;
  return [s, e];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Matcher {
  /** Null when every word was removed; `find` then matches nothing. */
  private regex: RegExp | null;
  private tiers: Map<string, Tier>;
  private allow: Set<string>;

  constructor(overrides?: Overrides) {
    const add = overrides?.add ?? [];
    const remove = overrides?.remove ?? [];
    const allow = overrides?.allow ?? [];

    const removed = new Set(remove);

    // First insertion wins, like Aho-Corasick reporting the lowest pattern id
    // for duplicate patterns.
    const tiers = new Map<string, Tier>();
    for (const [w, t] of LEXICON) {
      if (!removed.has(w) && !tiers.has(w)) tiers.set(w, t);
    }
    for (const [w, t] of add) {
      // Removal compares the raw string, before lowercasing — as v1 did.
      if (removed.has(w)) continue;
      const lower = asciiLower(w);
      // Deliberate divergence: v1 pushed an empty add word as an empty
      // Aho-Corasick pattern, yielding zero-width hits everywhere and a panic
      // on non-ASCII text. It is dropped here instead of replicated.
      if (lower && !tiers.has(lower)) tiers.set(lower, t);
    }

    // Longest-first alternation plus a left-to-right scan is equivalent to
    // Aho-Corasick's LeftmostLongest for plain strings.
    const words = [...tiers.keys()].sort((a, b) => b.length - a.length);
    this.regex = words.length === 0 ? null : new RegExp(words.map(escapeRegex).join("|"), "g");
    this.tiers = tiers;
    this.allow = new Set([...ALLOWLIST, ...allow.map(asciiLower)]);
  }

  /** Returns every confirmed swear in `text`. */
  find(text: string): Hit[] {
    if (!this.regex) return [];
    const normalised = normalise(text);
    const hits: Hit[] = [];

    this.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = this.regex.exec(normalised)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isWordBoundary(normalised, start, end)) continue;
      // Reject when the surrounding whole word is an innocent one.
      const [ws, we] = wholeWord(normalised, start, end);
      const whole = normalised.slice(ws, we);
      if (this.allow.has(whole)) continue;
      hits.push({ word: m[0], tier: this.tiers.get(m[0])!, surface: whole });
    }
    return hits;
  }
}
