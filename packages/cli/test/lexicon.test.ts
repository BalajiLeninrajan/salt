import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { additions, loadOverrides } from "../src/lexicon.js";

const dir = mkdtempSync(join(tmpdir(), "salt-lexicon-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const lexiconFile = (body: string): string => {
  const p = join(dir, `lexicon-${n++}.toml`);
  writeFileSync(p, body);
  return p;
};

describe("lexicon", () => {
  test("parses all sections", () => {
    const o = loadOverrides(
      lexiconFile(
        `
        remove = ["hell"]
        allow = ["cassowary"]
        [add]
        blast = "mild"
        `,
      ),
    );
    expect(o.remove).toEqual(["hell"]);
    expect(o.allow).toEqual(["cassowary"]);
    expect(additions(o)).toEqual([["blast", "mild"]]);
  });

  test("ignores unknown tiers", () => {
    const o = loadOverrides(lexiconFile('[add]\nblast = "spicy"'));
    expect(additions(o)).toEqual([]);
  });

  test("tier trim is Unicode whitespace, v1 style", () => {
    // U+0085 NEL is whitespace to Rust's trim, so the entry is accepted…
    expect(additions({ add: { blast: "\u0085mild" }, remove: [], allow: [] })).toEqual([
      ["blast", "mild"],
    ]);
    // …while U+FEFF is not, so this one is silently dropped.
    expect(additions({ add: { blast: "\uFEFFmild" }, remove: [], allow: [] })).toEqual([]);
  });

  test("missing default file is not an error", () => {
    // Like the v1 test, this consults the real default path: absent or valid
    // is ok, and only a malformed ~/.config/salt/lexicon.toml would throw.
    expect(() => loadOverrides()).not.toThrow();
  });

  test("missing explicit file is an error", () => {
    expect(() => loadOverrides("/nonexistent/lexicon.toml")).toThrow();
  });
});
