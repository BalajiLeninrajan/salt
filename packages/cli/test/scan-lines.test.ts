import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LineGate, forEachLine } from "../src/scan/lines.js";

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

  // The gated path does not walk the file line by line: it seeks `probe` and
  // works backwards to the line start, so every one of these cases is a way
  // that reconstruction could pick the wrong bounds. The chunk size is 1 MiB.
  describe("gated", () => {
    const GATE: LineGate = {
      probe: Buffer.from("_m"),
      needles: [Buffer.from('"user_message"'), Buffer.from('"session_meta"')],
    };

    const collect = async (body: string): Promise<string[]> => {
      const dir = mkdtempSync(join(tmpdir(), "salt-gate-"));
      try {
        const file = join(dir, "r.jsonl");
        writeFileSync(file, body);
        const out: string[] = [];
        await forEachLine(file, (l) => out.push(l), GATE);
        return out;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test("keeps only lines matching a needle, in file order", async () => {
      const body = [
        '{"a":"nothing here"}',
        '{"t":"user_message","i":1}',
        '{"t":"token_count"}',
        '{"t":"session_meta"}',
        '{"t":"user_message","i":2}',
      ].join("\n");
      expect(await collect(body)).toEqual([
        '{"t":"user_message","i":1}',
        '{"t":"session_meta"}',
        '{"t":"user_message","i":2}',
      ]);
    });

    test("a line carrying the probe but no needle is rejected", async () => {
      // `_m` is a superset filter; only the needles decide.
      expect(await collect('{"t":"other_mode"}\n{"t":"user_message"}')).toEqual([
        '{"t":"user_message"}',
      ]);
    });

    test("a matching line straddling the chunk boundary survives", async () => {
      // Pad so the interesting line begins just before 1 MiB and ends after.
      const pad = `{"pad":"${"x".repeat(4000)}"}`;
      const lines: string[] = [];
      let size = 0;
      while (size < (1 << 20) - 40) {
        lines.push(pad);
        size += pad.length + 1;
      }
      const straddler = `{"t":"user_message","big":"${"y".repeat(200_000)}"}`;
      lines.push(straddler, '{"t":"session_meta"}');
      expect(await collect(lines.join("\n"))).toEqual([straddler, '{"t":"session_meta"}']);
    });

    test("a match in the final line with no trailing newline survives", async () => {
      expect(await collect('{"a":1}\n{"t":"user_message","last":true}')).toEqual([
        '{"t":"user_message","last":true}',
      ]);
    });

    test("a match on the very first line survives", async () => {
      expect(await collect('{"t":"user_message","first":true}\n{"a":1}')).toEqual([
        '{"t":"user_message","first":true}',
      ]);
    });

    test("CRLF endings and blank lines are handled", async () => {
      expect(await collect('{"a":1}\r\n\r\n{"t":"user_message"}\r\n')).toEqual([
        '{"t":"user_message"}',
      ]);
    });

    test("a line longer than a chunk, spanning several chunks, survives", async () => {
      const huge = `{"t":"user_message","big":"${"z".repeat(3 << 20)}"}`;
      expect(await collect(`{"a":1}\n${huge}\n{"b":2}`)).toEqual([huge]);
    });
  });
});
