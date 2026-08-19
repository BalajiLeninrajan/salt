import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachLine } from "../src/scan/lines.js";

describe("scan/lines", () => {
  test("a file that will not open throws", async () => {
    expect(forEachLine(join(tmpdir(), "salt-no-such-file.jsonl"), () => {})).rejects.toThrow();
  });

  test("a read error after open ends the file quietly", async () => {
    // A directory opens fine but fails on the first read. v1's read loop
    // stopped silently at the error, keeping whatever had parsed, and did not
    // count the file as failed.
    const dir = mkdtempSync(join(tmpdir(), "salt-lines-"));
    try {
      const lines: string[] = [];
      await forEachLine(dir, (l) => lines.push(l));
      expect(lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
