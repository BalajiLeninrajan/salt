// Parity harness for the Rust rewrite.
//
// The rewrite's correctness bar is "produces the same report as the TypeScript
// CLI did", and two things make that harder to check than it sounds.
//
// First, the corpus is *live*: Claude Code writes to `~/.claude/projects` while
// you measure, so re-running the reference implementation an hour apart gives
// different numbers. A phantom 11-message discrepancy was chased for a while
// before that was understood. So parity is judged against a frozen snapshot
// with `HOME` pointed at it, never against the real `$HOME`.
//
// Second, the two implementations cannot be compared byte for byte.
// `JSON.stringify` writes an integral f64 as `50`, `serde_json` writes `50.0`.
// A textual diff would flag every whole-numbered rate. So the comparison parses
// both sides and walks the structures, comparing numbers by value.
//
// Usage:
//   node scripts/parity.mjs freeze            # build the snapshot (idempotent)
//   node scripts/parity.mjs record <label> -- <cmd...>
//   node scripts/parity.mjs check <a> <b>     # compare two recorded reports

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

const BASE = join(homedir(), ".cache", "salt-parity");
const CORPUS = join(BASE, "corpus");
const REPORTS = join(BASE, "reports");

/**
 * Fraction of files taken per root. The snapshot only has to exercise every
 * code path and be big enough to cross the parallel-scan threshold; copying all
 * 16 GB would make the harness unusable.
 */
const SAMPLE = { claude: 3, codexSessions: 10, codexArchived: 10, cursor: 1 };

function walk(root, keep, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  // Sorted so the sample is deterministic across machines and runs.
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (e.isFile() && keep(p)) out.push(p);
  }
  return out;
}

function freeze() {
  const home = homedir();
  if (existsSync(CORPUS)) rmSync(CORPUS, { recursive: true, force: true });

  const jsonl = (p) => p.endsWith(".jsonl");
  const pick = (files, nth) => files.filter((_, i) => i % nth === 0);

  const chosen = [
    ...pick(walk(join(home, ".claude", "projects"), jsonl), SAMPLE.claude),
    ...pick(walk(join(home, ".codex", "sessions"), jsonl), SAMPLE.codexSessions),
    ...pick(walk(join(home, ".codex", "archived_sessions"), jsonl), SAMPLE.codexArchived),
    // Cursor is tiny and every db exercises a different path (one is
    // WAL-only, which is what produces the 2 "failed" files), so take all of
    // them — plus the sibling meta.json that carries cwd and timestamps.
    ...walk(join(home, ".cursor", "chats"), (p) => p.endsWith("store.db") || p.endsWith("meta.json")),
  ];

  let bytes = 0;
  for (const src of chosen) {
    const dst = join(CORPUS, relative(home, src));
    mkdirSync(dirname(dst), { recursive: true });
    try {
      copyFileSync(src, dst);
      bytes += statSync(src).size;
    } catch {
      // a file that vanished mid-freeze is simply not in the snapshot
    }
  }
  writeFileSync(
    join(BASE, "corpus.json"),
    `${JSON.stringify({ files: chosen.length, bytes, frozen: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`frozen: ${chosen.length} files, ${(bytes / 1e9).toFixed(2)} GB → ${CORPUS}`);
}

/** Runs a CLI against the snapshot and stores its report under `label`. */
function record(label, cmd) {
  if (!existsSync(CORPUS)) throw new Error("no snapshot — run `parity.mjs freeze` first");
  mkdirSync(REPORTS, { recursive: true });

  const started = Date.now();
  const r = spawnSync(cmd[0], [...cmd.slice(1), "--json"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // HOME is the whole trick: every scanner roots its search there.
    env: { ...process.env, HOME: CORPUS },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);

  if (r.status !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${r.status}\n${r.stderr}`);
  }
  const report = JSON.parse(r.stdout);
  writeFileSync(join(REPORTS, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const c = report.coverage;
  console.log(
    `recorded ${label} in ${elapsed}s — ${c.files_scanned} files, ` +
      `${c.files_failed} failed, ${report.totals.prompts} prompts, ${report.totals.swears} swears`,
  );
}

/**
 * Structural comparison. `generated_at` and `version` are expected to differ
 * and are skipped; everything else must match, with numbers compared by value
 * so `50` and `50.0` agree.
 */
function diff(a, b, path = "", out = []) {
  if (path === "/generated_at" || path === "/version") return out;

  if (typeof a === "number" && typeof b === "number") {
    // Exact: a drifting rate means a real counting difference, and rounding it
    // away is how a genuine bug would hide.
    if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) out.push({ path, a, b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path, a: `array[${a.length}]`, b: `array[${b.length}]` });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}/${i}`, out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push({ path: `${path}/${k}`, a: "<missing>", b: b[k] });
      else if (!(k in b)) out.push({ path: `${path}/${k}`, a: a[k], b: "<missing>" });
      else diff(a[k], b[k], `${path}/${k}`, out);
    }
    return out;
  }
  if (a !== b) out.push({ path, a, b });
  return out;
}

function check(labelA, labelB) {
  const load = (l) => JSON.parse(readFileSync(join(REPORTS, `${l}.json`), "utf8"));
  const a = load(labelA);
  const b = load(labelB);

  const deltas = diff(a, b);
  // Field order is part of the contract too, and the structural walk above is
  // order-blind, so check it separately.
  const orderA = JSON.stringify(Object.keys(a));
  const orderB = JSON.stringify(Object.keys(b));
  if (orderA !== orderB) console.log(`field order differs:\n  ${labelA}: ${orderA}\n  ${labelB}: ${orderB}`);

  if (deltas.length === 0) {
    console.log(`PARITY: ${labelA} == ${labelB} ✓`);
    return;
  }
  console.log(`PARITY: ${deltas.length} difference(s) between ${labelA} and ${labelB}\n`);
  for (const d of deltas.slice(0, 60)) {
    console.log(`  ${d.path}\n    ${labelA}: ${JSON.stringify(d.a)}\n    ${labelB}: ${JSON.stringify(d.b)}`);
  }
  if (deltas.length > 60) console.log(`  … ${deltas.length - 60} more`);
  process.exitCode = 1;
}

const [mode, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("--");
const args = sep === -1 ? rest : rest.slice(0, sep);
const cmd = sep === -1 ? [] : rest.slice(sep + 1);

if (mode === "freeze") freeze();
else if (mode === "record") record(args[0], cmd);
else if (mode === "check") check(args[0], args[1]);
else {
  console.error("usage: parity.mjs freeze | record <label> -- <cmd...> | check <a> <b>");
  process.exit(2);
}
