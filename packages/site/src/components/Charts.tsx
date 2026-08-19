import type { AgentDayStat, DayStat, HarnessStats, HeatCell } from "@salt/core";
import { AGENT_LINE_COLOR, HARNESS_LABEL } from "@salt/core";

const num = new Intl.NumberFormat("en-US");

const HARNESSES: HarnessStats["harness"][] = ["claude", "codex", "cursor"];

/**
 * Daily prompts and swears, plus one agent-swear line per harness.
 *
 * Every swear series shares one y-axis so the agent lines are directly
 * comparable with the user's — the point of the comparison is that they sit far
 * lower, and rescaling each series to its own peak would hide exactly that.
 */
export function Timeline({
  daily,
  agentDaily,
}: {
  daily: DayStat[];
  agentDaily: AgentDayStat[];
}) {
  if (daily.length === 0) return null;

  // The x-axis is the union of both sides: a harness can have replies on a day
  // with no surviving prompt of its own.
  const dates = [
    ...new Set([...daily.map((d) => d.date), ...agentDaily.map((d) => d.date)]),
  ].sort();
  const index = new Map(dates.map((d, i) => [d, i]));

  // Absent days are genuinely zero, not gaps, so every series is dense.
  const userSwears = new Array<number>(dates.length).fill(0);
  const prompts = new Array<number>(dates.length).fill(0);
  for (const d of daily) {
    const i = index.get(d.date)!;
    userSwears[i] = d.swears;
    prompts[i] = d.prompts;
  }

  // A harness gets a line if it ever replied, even if it never swore — a flat
  // line at zero is the finding. A harness that was never used gets nothing.
  const agentSeries = HARNESSES.map((harness) => {
    const values = new Array<number>(dates.length).fill(0);
    let total = 0;
    let active = false;
    for (const d of agentDaily) {
      if (d.harness !== harness) continue;
      active = true;
      values[index.get(d.date)!] = d.swears;
      total += d.swears;
    }
    return { harness, values, total, active };
  }).filter((s) => s.active);

  const W = 960;
  const H = 230;
  const PAD = { l: 8, r: 40, t: 12, b: 22 };
  const maxPrompts = Math.max(...prompts, 1);
  const maxSwears = Math.max(...userSwears, ...agentSeries.flatMap((s) => s.values), 1);

  const x = (i: number) => PAD.l + (i / Math.max(dates.length - 1, 1)) * (W - PAD.l - PAD.r);
  const yP = (v: number) => PAD.t + (1 - v / maxPrompts) * (H - PAD.t - PAD.b);
  const yS = (v: number) => PAD.t + (1 - v / maxSwears) * (H - PAD.t - PAD.b);

  const area = [
    `M ${x(0)} ${H - PAD.b}`,
    ...prompts.map((v, i) => `L ${x(i)} ${yP(v)}`),
    `L ${x(dates.length - 1)} ${H - PAD.b} Z`,
  ].join(" ");
  const line = (values: number[]) =>
    values.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${yS(v)}`).join(" ");

  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const ticks = [maxSwears, Math.round(maxSwears / 2)].filter((v, i, a) => v > 0 && a.indexOf(v) === i);

  return (
    <>
      <div className="chart-well">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Prompts and swears per day, theirs and the agent's, from ${first} to ${last}`}
        >
          <defs>
            <linearGradient id="promptFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--surface-2)" stopOpacity="0.42" />
              <stop offset="100%" stopColor="var(--surface-2)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#promptFill)" />
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={yS(v)}
                y2={yS(v)}
                stroke="var(--surface-0)"
                strokeWidth="1"
                strokeDasharray="3 5"
              />
              <text
                x={W - PAD.r + 8}
                y={yS(v) + 3}
                fill="var(--overlay-0)"
                fontFamily="var(--mono)"
                fontSize="9"
                fontWeight="700"
              >
                {num.format(v)}
              </text>
            </g>
          ))}
          {/* Agent lines first so the user's own series stays on top. */}
          {agentSeries.map((s) => (
            <path
              key={s.harness}
              d={line(s.values)}
              fill="none"
              stroke={AGENT_LINE_COLOR[s.harness]}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          <path
            d={line(userSwears)}
            fill="none"
            stroke="var(--mauve)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <text
            x={PAD.l}
            y={H - 6}
            fill="var(--overlay-0)"
            fontFamily="var(--mono)"
            fontSize="9"
            fontWeight="700"
            letterSpacing="0.06em"
          >
            {first}
          </text>
          <text
            x={W - PAD.r}
            y={H - 6}
            textAnchor="end"
            fill="var(--overlay-0)"
            fontFamily="var(--mono)"
            fontSize="9"
            fontWeight="700"
            letterSpacing="0.06em"
          >
            {last}
          </text>
        </svg>
      </div>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-dot" style={{ background: "var(--surface-2)" }} />
          prompts / day · peak {num.format(maxPrompts)}
        </span>
        <span className="legend-item">
          <span className="legend-dot" style={{ background: "var(--mauve)" }} />
          their swears / day · peak {num.format(Math.max(...userSwears, 0))}
        </span>
        {agentSeries.map((s) => (
          <span key={s.harness} className="legend-item">
            <span className="legend-dot" style={{ background: AGENT_LINE_COLOR[s.harness] }} />
            {HARNESS_LABEL[s.harness]} back · {num.format(s.total)}
          </span>
        ))}
      </div>
    </>
  );
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 7×24 grid, mauve ramp by swear rate. dow 0 = Monday, per the schema. */
export function Heatmap({ cells }: { cells: HeatCell[] }) {
  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  const maxRate = Math.max(
    ...cells.filter((c) => c.prompts > 0).map((c) => c.swears / c.prompts),
    0.0001,
  );

  const CELL = 30;
  const GAP = 3;
  const LABEL_W = 34;
  const W = LABEL_W + 24 * (CELL + GAP);
  const H = 16 + 7 * (CELL + GAP);

  return (
    <div className="chart-well heat-scroll">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        role="img"
        aria-label="Swear rate by day of week and hour of day"
      >
        {Array.from({ length: 24 }, (_, h) =>
          h % 3 === 0 ? (
            <text
              key={h}
              x={LABEL_W + h * (CELL + GAP) + CELL / 2}
              y={10}
              textAnchor="middle"
              fill="var(--overlay-0)"
              fontFamily="var(--mono)"
              fontSize="8"
              fontWeight="700"
              letterSpacing="0.06em"
            >
              {String(h).padStart(2, "0")}
            </text>
          ) : null,
        )}
        {DOW.map((label, d) => (
          <g key={label}>
            <text
              x={0}
              y={16 + d * (CELL + GAP) + CELL / 2 + 3}
              fill="var(--overlay-0)"
              fontFamily="var(--mono)"
              fontSize="8"
              fontWeight="700"
              letterSpacing="0.06em"
            >
              {label}
            </text>
            {Array.from({ length: 24 }, (_, h) => {
              const c = byKey.get(`${d}:${h}`);
              const rate = c && c.prompts > 0 ? c.swears / c.prompts : 0;
              // Empty hours stay near-transparent so activity reads as shape.
              const alpha = c ? 0.07 + (rate / maxRate) * 0.88 : 0.03;
              return (
                <rect
                  key={h}
                  x={LABEL_W + h * (CELL + GAP)}
                  y={16 + d * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={7}
                  fill="var(--mauve)"
                  fillOpacity={alpha}
                >
                  <title>
                    {`${label} ${String(h).padStart(2, "0")}:00 — ` +
                      `${c?.swears ?? 0} swears in ${c?.prompts ?? 0} prompts`}
                  </title>
                </rect>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}
