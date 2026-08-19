import { open } from "node:fs/promises";

/**
 * Streams a file line by line without ever holding the whole file.
 *
 * Codex rollouts reach several megabytes and the corpus as a whole is tens of
 * gigabytes. Lines that are not valid UTF-8 are skipped rather than aborting
 * the file, and empty lines are dropped.
 *
 * A file that will not open throws — the scan counts it failed — but a read
 * error after that ends the file quietly, keeping the lines already seen, as
 * v1's read loop did.
 */
export async function forEachLine(
  path: string,
  f: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const handle = await open(path, "r");
  const stream = handle.createReadStream({ highWaterMark: 1 << 20 });
  let carry: Buffer | null = null;

  const emit = (buf: Buffer) => {
    let line: string;
    try {
      line = decoder.decode(buf);
    } catch {
      return; // invalid UTF-8 — skip the line, keep the file
    }
    line = line.replace(/[\r\n]+$/, "");
    if (line.length > 0) f(line);
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      while (true) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1) break;
        let slice = chunk.subarray(start, nl);
        if (carry) {
          slice = Buffer.concat([carry, slice]);
          carry = null;
        }
        emit(slice);
        start = nl + 1;
      }
      const rest = chunk.subarray(start);
      if (rest.length > 0) {
        carry = carry ? Buffer.concat([carry, rest]) : Buffer.from(rest);
      }
    }
  } catch {
    stream.destroy();
    return; // mid-file read error: keep what was already parsed
  }
  if (carry) emit(carry);
}
