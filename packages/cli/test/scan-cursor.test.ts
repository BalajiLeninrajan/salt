import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDb } from "../src/scan/cursor.js";
import type { Message } from "../src/types.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const META = '{"createdAtMs":1784571101149,"updatedAtMs":1784571882088,"cwd":"/tmp/proj"}';

function dbWith(blobs: (string | Uint8Array)[], meta = META): string {
  const dir = mkdtempSync(join(tmpdir(), "salt-cursor-test-"));
  tempDirs.push(dir);
  const chat = join(dir, "chat-1");
  mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, "meta.json"), meta);

  const db = new Database(join(chat, "store.db"), { create: true });
  db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?1, ?2)");
  blobs.forEach((b, i) => {
    insert.run(String(i), typeof b === "string" ? new TextEncoder().encode(b) : b);
  });
  db.close();
  return dir;
}

function parse(dir: string): Promise<Message[]> {
  return parseDb(join(dir, "chat-1/store.db"));
}

const USER_QUERY =
  '{"role":"user","content":[{"type":"text","text":"<user_query>\\nthis is broken\\n</user_query>"}]}';
const USER_INFO =
  '{"role":"user","content":"<user_info>\\nOS Version: darwin\\n\\nWorkspace Path: /tmp/from-info\\n</user_info>"}';
const ASSISTANT = '{"role":"assistant","content":[{"type":"text","text":"damn ok"}]}';
const PROTOBUF = new Uint8Array([0x0a, 0xca, 0x01, 0x72, 0x69, 0x67, 0x68, 0x74]);

describe("scan/cursor", () => {
  test("extracts only the wrapped query", async () => {
    // The ambient `<user_info>` blob and the protobuf blob both drop out; the
    // assistant blob survives as the agent's side.
    const dir = dbWith([USER_QUERY, USER_INFO, ASSISTANT, PROTOBUF]);
    const got = await parse(dir);
    expect(got.length).toBe(2);
    expect(got[0]!.role).toBe("user");
    expect(got[0]!.text).toBe("this is broken");
    expect(got[0]!.harness).toBe("cursor");
    expect(got[1]!.role).toBe("agent");
  });

  test("marks timestamps as session precision", async () => {
    const dir = dbWith([USER_QUERY]);
    expect((await parse(dir))[0]!.tsPrecision).toBe("session");
  });

  test("prefers meta.json cwd", async () => {
    const dir = dbWith([USER_QUERY]);
    expect((await parse(dir))[0]!.cwd).toBe("/tmp/proj");
  });

  test("ignores protobuf blobs without error", async () => {
    const dir = dbWith([PROTOBUF, PROTOBUF]);
    expect(await parse(dir)).toEqual([]);
  });

  test("ambient user_info alone yields nothing", async () => {
    const dir = dbWith([USER_INFO]);
    expect(await parse(dir)).toEqual([]);
  });

  test("one bad element rejects the whole content array", async () => {
    // v1's untagged Content enum failed wholesale on a mixed array.
    const dir = dbWith([
      '{"role":"assistant","content":[{"type":"text","text":"partial survives"},42]}',
    ]);
    expect(await parse(dir)).toEqual([]);
  });

  test("invalid UTF-8 rejects the blob", async () => {
    // serde_json::from_slice required valid UTF-8; lossy decoding would keep
    // blobs v1 never saw.
    const bytes = new TextEncoder().encode('{"role":"assistant","content":"bad ? utf8"}');
    bytes[bytes.indexOf(0x3f)] = 0xff;
    const dir = dbWith([bytes]);
    expect(await parse(dir)).toEqual([]);
  });

  test("one bad meta field discards the whole meta", async () => {
    // All-or-nothing like serde: the valid cwd goes down with the bad
    // timestamp, and the time falls back to the file mtime.
    for (const meta of [
      '{"updatedAtMs":"abc","cwd":"/kept"}',
      '{"updatedAtMs":1.5,"cwd":"/kept"}',
    ]) {
      const dir = dbWith([USER_QUERY], meta);
      const got = await parse(dir);
      expect(got.length).toBe(1);
      expect(got[0]!.cwd).toBeUndefined();
    }
  });

  test("out-of-range meta time falls back to mtime, cwd survives", async () => {
    // 1e18 ms is a valid i64 but beyond chrono's DateTime range.
    const dir = dbWith([USER_QUERY], '{"updatedAtMs":1000000000000000000,"cwd":"/kept"}');
    const got = await parse(dir);
    expect(got[0]!.cwd).toBe("/kept");
    expect(got[0]!.ts).toBeLessThan(1e18);
  });

  test("uncheckpointed WAL frames are invisible", async () => {
    // v1 opened with immutable=1, which reads only the main db file; rows a
    // live Cursor has not checkpointed yet must not appear.
    const dir = mkdtempSync(join(tmpdir(), "salt-cursor-test-"));
    tempDirs.push(dir);
    const chat = join(dir, "chat-1");
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, "meta.json"), META);
    const db = new Database(join(chat, "store.db"), { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?1, ?2)");
    insert.run("1", new TextEncoder().encode(USER_QUERY));
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    insert.run("2", new TextEncoder().encode(ASSISTANT));
    try {
      const got = await parse(dir);
      expect(got.length).toBe(1);
      expect(got[0]!.role).toBe("user");
    } finally {
      db.close();
    }
  });

  const ASSISTANT_SWEAR =
    '{"role":"assistant","content":[{"type":"text","text":"that was damn close"}]}';

  test("keeps assistant replies without a wrapper", async () => {
    // Assistant blobs carry no `<user_query>` wrapper. That requirement applies
    // only to the user side, where it separates a typed prompt from the ambient
    // `<user_info>` block.
    const dir = dbWith([USER_QUERY, ASSISTANT_SWEAR]);
    const got = await parse(dir);
    expect(got.length).toBe(2);
    expect(got[0]!.role).toBe("user");
    expect(got[1]!.role).toBe("agent");
    expect(got[1]!.text).toBe("that was damn close");
  });
});
