import { open } from "node:fs/promises";

/**
 * A byte-level filter for lines worth decoding.
 *
 * `needles` is the real test: a line is kept only if it contains one of them.
 * `probe` is a short string contained in *every* needle, used to find
 * candidate lines without walking the file line by line — see `forEachLine`.
 */
export interface LineGate {
  probe: Uint8Array;
  needles: readonly Uint8Array[];
}

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
 *
 * Passing a `gate` switches the loop from "split every line, test each" to
 * "find the next candidate byte, then work out which line it is on". Callers
 * discard the overwhelming majority of lines — a sampled rollout held 1,841
 * `token_count` events against 20 `user_message` — and at that ratio the
 * line-splitting is itself the dominant cost, not the matching. Seeking the
 * probe instead measured ~1.4x faster over the codex corpus, on top of the ~3x
 * from not decoding rejected lines at all. Needles must be ASCII: they are
 * matched against UTF-8 bytes, where a multi-byte character can never contain
 * an ASCII byte.
 */
export async function forEachLine(
  path: string,
  f: (line: string) => void,
  gate?: LineGate,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const handle = await open(path, "r");
  const stream = handle.createReadStream({ highWaterMark: 1 << 20 });
  let carry: Buffer | null = null;

  const emit = (buf: Buffer) => {
    // Trim the trailing CR/LF bytes before decoding rather than regexing the
    // decoded string: both are ASCII, so this cannot split a code point.
    let end = buf.length;
    while (end > 0 && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end--;
    if (end === 0) return;
    const slice = end === buf.length ? buf : buf.subarray(0, end);

    if (gate !== undefined) {
      let hit = false;
      for (const needle of gate.needles) {
        if (slice.includes(needle)) {
          hit = true;
          break;
        }
      }
      if (!hit) return;
    }

    let line: string;
    try {
      line = decoder.decode(slice);
    } catch {
      return; // invalid UTF-8 — skip the line, keep the file
    }
    if (line.length > 0) f(line);
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (gate === undefined) {
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
        continue;
      }

      // Gated: the only line that has to be reassembled is the one straddling
      // the chunk boundary. The rest are located by seeking the probe, so
      // lines with no candidate byte are never sliced at all.
      const firstNl = chunk.indexOf(0x0a);
      if (firstNl === -1) {
        carry = carry ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
        continue;
      }
      emit(carry ? Buffer.concat([carry, chunk.subarray(0, firstNl)]) : chunk.subarray(0, firstNl));
      carry = null;

      const lastNl = chunk.lastIndexOf(0x0a);
      let from = firstNl + 1;
      while (from <= lastNl) {
        const hit = chunk.indexOf(gate.probe, from);
        if (hit === -1 || hit > lastNl) break;
        const lineStart = chunk.lastIndexOf(0x0a, hit) + 1;
        const nl = chunk.indexOf(0x0a, hit);
        emit(chunk.subarray(lineStart, nl));
        from = nl + 1;
      }
      if (lastNl + 1 < chunk.length) carry = Buffer.from(chunk.subarray(lastNl + 1));
    }
  } catch {
    stream.destroy();
    return; // mid-file read error: keep what was already parsed
  }
  if (carry) emit(carry);
}
