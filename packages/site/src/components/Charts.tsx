import type { AgentDayStat, DayStat, HarnessStats } from "@salt/core";
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
          your swears / day · peak {num.format(Math.max(...userSwears, 0))}
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
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Seven steps of one mauve, mixed against the well behind them, topping out
 * at the accent itself.
 *
 * Ramping opacity over a single fill is what made earlier versions unreadable:
 * 0.75 and 0.92 mauve on this background are the same square to the eye, and
 * the top of the range is exactly where the differences matter. Mixing in
 * oklab spends the ramp on lightness instead, in steps the eye reads evenly.
 */
const LEVELS = [
  "color-mix(in oklab, var(--mauve) 20%, var(--mantle))",
  "color-mix(in oklab, var(--mauve) 33%, var(--mantle))",
  "color-mix(in oklab, var(--mauve) 46%, var(--mantle))",
  "color-mix(in oklab, var(--mauve) 60%, var(--mantle))",
  "color-mix(in oklab, var(--mauve) 73%, var(--mantle))",
  "color-mix(in oklab, var(--mauve) 86%, var(--mantle))",
  "var(--mauve)",
];
/** Prompts that day, but nothing worth counting. */
const QUIET = "color-mix(in oklab, var(--mauve) 11%, var(--mantle))";
/** No prompts at all — before the first session, or a day off. */
const EMPTY = "color-mix(in oklab, var(--mauve) 4%, var(--mantle))";

/** Blank weeks before the first prompt and after the last. */
const PAD_WEEKS = 2;

/** A local `YYYY-MM-DD`, parsed back into the local day it names. */
function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(from: Date, n: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return d;
}

function isoOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday-based row index, matching the schema's day-of-week convention. */
const row = (d: Date) => (d.getDay() + 6) % 7;

/**
 * A contributions-style calendar: one column per week, one cell per day,
 * shaded by that day's severity-weighted swear total.
 *
 * Weight is missing on reports published before it existed; those fall back to
 * a flat count.
 */
export function Calendar({ daily }: { daily: DayStat[] }) {
  if (daily.length === 0) return null;

  const byDate = new Map(daily.map((d) => [d.date, d]));
  const weightOf = (d: DayStat) => d.weight ?? d.swears;

  // Whole weeks either side, so every column is a full seven cells, plus a
  // couple of blank ones at each end — the grid reads as a stretch of calendar
  // the run happens to sit in, not as a block that starts where the data does.
  const dates = daily.map((d) => d.date).sort();
  const first = parseDay(dates[0]!);
  const last = parseDay(dates[dates.length - 1]!);
  const start = addDays(first, -row(first) - PAD_WEEKS * 7);
  const end = addDays(last, 6 - row(last) + PAD_WEEKS * 7);
  const weeks = Math.round((end.getTime() - start.getTime()) / 604_800_000) + 1;

  // The ramp spans this report's own range — quietest swearing day to loudest
  // — rather than starting from zero, where the bottom step would go unused:
  // the mildest word on the list already scores a 5.
  const lit = daily.map(weightOf).filter((w) => w > 0);
  const floor = Math.log1p(Math.min(...lit));
  const span = Math.log1p(Math.max(...lit)) - floor;
  const tone = (w: number) => {
    if (span <= 0) return LEVELS[LEVELS.length - 1]!;
    const step = Math.ceil((LEVELS.length * (Math.log1p(w) - floor)) / span);
    return LEVELS[Math.min(LEVELS.length, Math.max(step, 1)) - 1]!;
  };

  const CELL = 22;
  const GAP = 4;
  const LABEL_W = 40;
  const TOP = 22;
  const W = LABEL_W + weeks * (CELL + GAP);
  const H = TOP + 7 * (CELL + GAP);

  return (
    <div className="chart-well heat-scroll">
      {/* Natural size, centred: a short report is a small calendar, not a
          handful of enormous squares stretched across the well. */}
      <svg
        className="cal"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label="Severity-weighted swear volume per day"
      >
        {/* A month is labelled at the first column whose Monday falls in it. */}
        {Array.from({ length: weeks }, (_, w) => {
          const monday = addDays(start, w * 7);
          const prev = addDays(start, (w - 1) * 7);
          if (w > 0 && monday.getMonth() === prev.getMonth()) return null;
          return (
            <text
              key={`m${w}`}
              x={LABEL_W + w * (CELL + GAP)}
              y={11}
              fill="var(--overlay-0)"
              fontFamily="var(--mono)"
              fontSize="9"
              fontWeight="700"
              letterSpacing="0.06em"
            >
              {MONTHS[monday.getMonth()]}
            </text>
          );
        })}
        {DOW.map((label, d) =>
          d % 2 === 0 ? (
            <text
              key={label}
              x={0}
              y={TOP + d * (CELL + GAP) + CELL / 2 + 3}
              fill="var(--overlay-0)"
              fontFamily="var(--mono)"
              fontSize="9"
              fontWeight="700"
              letterSpacing="0.06em"
            >
              {label}
            </text>
          ) : null,
        )}
        {Array.from({ length: weeks }, (_, w) =>
          Array.from({ length: 7 }, (_, d) => {
            const day = addDays(start, w * 7 + d);
            const iso = isoOf(day);
            const stat = byDate.get(iso);
            const weight = stat ? weightOf(stat) : 0;
            const shade = !stat ? EMPTY : weight === 0 ? QUIET : tone(weight);
            return (
              <rect
                key={iso}
                x={LABEL_W + w * (CELL + GAP)}
                y={TOP + d * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={5}
                fill={shade}
              >
                <title>
                  {stat
                    ? `${iso} — ${stat.swears} swears in ${stat.prompts} prompts · severity ${weight}`
                    : `${iso} — no prompts`}
                </title>
              </rect>
            );
          }),
        )}
      </svg>
      <div className="legend heat-legend">
        <span className="legend-item">quieter</span>
        {LEVELS.map((fill) => (
          <span key={fill} className="legend-swatch" style={{ background: fill }} />
        ))}
        <span className="legend-item">louder</span>
      </div>
    </div>
  );
}
