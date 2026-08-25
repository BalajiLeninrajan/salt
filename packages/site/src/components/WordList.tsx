import type { WordStat } from "@salt/core";
import { TIER_COLOR } from "@salt/core";

const num = new Intl.NumberFormat("en-US");

/** Ranked word rows: rank, word, tier chip, tier-colored bar, count. */
export function WordList({ words }: { words: WordStat[] }) {
  const max = Math.max(...words.map((w) => w.count), 1);

  return (
    <div className="word-list">
      {words.map((w, i) => (
        <div
          key={w.word}
          className="word-row"
          // Focusable so the data-tip bubble (hover / :focus-visible only)
          // is reachable from the keyboard; the sr-only span below carries
          // the same fact for assistive tech.
          tabIndex={0}
          data-tip={`${(w.share * 100).toFixed(1)}% of all swears`}
        >
          <span className="word-rank">{String(i + 1).padStart(2, "0")}</span>
          <span className="word-cell">
            <span className="cn-name">{w.word}</span>
            <span
              className="chip-tone word-tier"
              style={{ ["--tier-color" as string]: TIER_COLOR[w.tier] }}
            >
              {w.tier}
            </span>
          </span>
          <span className="progress-track bar-track">
            <span
              className="bar-fill"
              style={{ width: `${(w.count / max) * 100}%`, background: TIER_COLOR[w.tier] }}
            />
          </span>
          <span className="word-count">{num.format(w.count)}</span>
          <span className="cn-sr-only">
            {(w.share * 100).toFixed(1)}% of all swears
          </span>
        </div>
      ))}
    </div>
  );
}
