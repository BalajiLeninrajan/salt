import type { Message } from "../types.js";

/**
 * Collapses replayed messages, keeping the earliest occurrence of each.
 *
 * Codex rewrites a session's entire history into a new rollout file on every
 * fork and resume; a single prompt was observed 405 times in the corpus this
 * was built against. Replays are stamped with fresh timestamps, so time cannot
 * distinguish them — but a given text within a given session is one message
 * however many files it lands in. Agent replies are replayed by exactly the
 * same mechanism, so they get the same treatment.
 *
 * The cost is that genuinely repeating the same text twice in one session
 * counts once. That undercounts slightly, which is the right direction to err
 * versus inflating the headline number ~1.4x.
 *
 * The key ignores timestamps, so the surviving set does not depend on the
 * order messages arrive in. That is what lets each worker collapse its own
 * shard before shipping it back: a second pass over the merged result reaches
 * the same answer as one global pass, having moved a third of the messages.
 */
export function dedup(messages: Message[]): number {
  const before = messages.length;
  messages.sort((a, b) => a.ts - b.ts);
  const seen = new Set<string>();
  let write = 0;
  for (const m of messages) {
    const key = `${m.harness}\x00${m.role}\x00${m.sessionId}\x00${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages[write++] = m;
  }
  messages.length = write;
  return before - messages.length;
}
