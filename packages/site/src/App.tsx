import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { ProjectStat, Report } from "@salt/core";
import { AGENT_LINE_COLOR, HARNESS_LABEL, REPORT_TTL_DAYS, TIER_COLOR } from "@salt/core";
import { CopyCommand, CopyLink } from "./components/CopyLink";
import { Logo } from "./components/Logo";
import {
  agentVerdict,
  depositDays,
  fillPercent,
  HARNESSES,
  jarCapacity,
  monthStarts,
  oneIn,
  sharePercent,
  type Harness,
} from "./jar";

const num = new Intl.NumberFormat("en-US");

declare global {
  interface Window {
    /** Seeded by the Worker into the HTML it serves for a published report. */
    __SALT_REPORT_ID__?: string;
  }
}

/**
 * The report is a swear jar: every swear dropped one coin in. Each section
 * reads one part of the jar (how full it is and who filled it, what is in
 * it, the agents' much smaller jar, the day each coin went in, where the
 * jar sat), so the page is built around that one object.
 *
 * The page addresses the person who ran and published the report as "you",
 * even though anyone with the link can view it. Data-handling details live in
 * the methodology footer, not in every section.
 */
const REPORT_ID =
  typeof window === "undefined" ? undefined : window.__SALT_REPORT_ID__;

/** Harness tones as package tokens, the same hues as HARNESS_COLOR. */
const TONE: Record<Harness, string> = AGENT_LINE_COLOR;

const longDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});
const dayDate = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const dayOf = (date: string) => dayDate.format(new Date(`${date}T00:00:00Z`));

const coins = (n: number) => `${num.format(n)} ${n === 1 ? "coin" : "coins"}`;

/** Custom properties inline, typed once. */
const vars = (v: Record<string, string | number>) => v as CSSProperties;

export default function App() {
  const [report, setReport] = useState<Report | null>(null);
  // "gone" only when there is no id or the store says 404: that report is
  // expired for good. Anything else (a 5xx, a dropped connection) can
  // succeed on a retry, so it must not claim the numbers are gone.
  const [failed, setFailed] = useState<"gone" | "error" | null>(REPORT_ID ? null : "gone");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!REPORT_ID) return;
    fetch(`/api/report/${REPORT_ID}`)
      .then((r) => {
        if (r.status === 404) return setFailed("gone");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json().then(setReport);
      })
      .catch(() => setFailed("error"));
  }, [attempt]);

  if (failed === "gone") return <EmptyState />;
  if (failed === "error") {
    return (
      <LoadError
        onRetry={() => {
          setFailed(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!report) {
    return (
      <Frame>
        <main className="page-main">
          <div className="empty-state">
            <span>Loading the report</span>
          </div>
        </main>
      </Frame>
    );
  }
  return <ReportPage report={report} />;
}

function ReportPage({ report }: { report: Report }) {
  // Each jar has its own capacity, sized to what went in it. The agents'
  // jar is a much smaller jar, so its handful of coins still reads.
  const capacity = jarCapacity(report.totals.swears);
  const showAgents = report.agent.messages > 0;

  return (
    <Frame action={<CopyLink url={window.location.href} />}>
      <main className="page-main page-enter cn-stack cn-gap-32 st-report">
        <Hero report={report} capacity={capacity} />
        <div className={showAgents ? "st-split" : undefined}>
          <Contents report={report} />
          {showAgents && <AgentJar report={report} capacity={capacity} />}
        </div>
        <Deposits report={report} />
        <Where report={report} />
        <Methodology report={report} />
      </main>
    </Frame>
  );
}

/**
 * The page frame: a compact bar with the wordmark and, on a report, the one
 * action the page has. The bar is sticky, so the link is always one click
 * away however far down the report the reader has got.
 */
function Frame({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div className="app-shell" style={vars({ "--page-width": "1080px" })}>
      <header className="topbar is-split cn-bg-mantle">
        <a className="wordmark is-lg" href="/">
          <Logo />
        </a>
        {action}
      </header>
      {children}
    </div>
  );
}

/**
 * No id, or the id no longer resolves: reports expire on purpose. The same
 * jar with nothing in it, and the command that fills a new one.
 */
function EmptyState() {
  return (
    <Frame>
      <main className="page-main is-narrow page-enter st-gone">
        <div className="st-shelved" aria-hidden="true">
          <Jar capacity={1} />
          <div className="st-shelf" />
        </div>
        <h1 className="cn-display is-sm cn-m-0">This jar was emptied.</h1>
        <p className="cn-lede cn-m-0">
          Reports live for {REPORT_TTL_DAYS} days, then the numbers are gone for
          good. Fill a new one from your own machine.
        </p>
        <CopyCommand command="npx salt-ai" />
        <a className="btn-text" href="/">
          What is salt?
        </a>
      </main>
    </Frame>
  );
}

/** The report may still exist; the fetch failed. Say so and offer a retry. */
function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Frame>
      <main className="page-main is-narrow">
        <div className="empty-state" role="alert">
          <strong>Couldn't load this report</strong>
          <span>The link is fine. The server or your connection didn't answer.</span>
          <button type="button" className="btn btn-secondary cn-mt-12" onClick={onRetry}>
            Try again
          </button>
        </div>
      </main>
    </Frame>
  );
}

interface Coins {
  key: string;
  n: number;
  tone: string;
}

/**
 * A jar: a raised lid on a carved glass, filled from the bottom to its share
 * of `capacity` with coin-striped plates. `stack` runs bottom first, and each
 * plate's share of the fill is its share of the coins.
 */
function Jar({
  stack = [],
  capacity,
  label,
}: {
  stack?: Coins[];
  capacity: number;
  label?: string;
}) {
  const total = stack.reduce((s, c) => s + c.n, 0);
  const fill = fillPercent(total, capacity);
  const shown = stack.filter((c) => c.n > 0).reverse();
  return (
    <figure
      className="st-jar cn-m-0"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div className="st-lid" />
      <div className="st-glass well cn-bg-well">
        <div className="st-inside">
        {fill > 0 && (
          <div
            // A sliver has no room for gaps between plates; they would read
            // as more coins than there are.
            className={`st-fill${fill < 6 ? " is-sliver" : ""}`}
            style={vars({ "--fill": `${fill}%` })}
          >
            {shown.map((c) => (
              <span
                key={c.key}
                className="st-coins"
                style={vars({ "--n": c.n, "--accent": c.tone })}
              />
            ))}
          </div>
        )}
        </div>
      </div>
    </figure>
  );
}

function Hero({ report, capacity }: { report: Report; capacity: number }) {
  const t = report.totals;
  const salty = t.prompts ? (100 * t.prompts_with_swear) / t.prompts : 0;
  const every = oneIn(t.prompts, t.prompts_with_swear);
  const taken = new Date(report.generated_at);
  const expires = new Date(taken.getTime() + REPORT_TTL_DAYS * 86_400_000);
  const rate = `That is ${t.swears_per_100_prompts.toFixed(1)} swears for every 100 prompts you typed.`;

  // Largest at the bottom of the jar; the key reads top down, like the jar.
  const used = report.by_harness
    .filter((h) => h.prompts > 0)
    .sort((a, b) => b.swears - a.swears);
  const stack = used.map((h) => ({ key: h.harness, n: h.swears, tone: TONE[h.harness] }));
  const worst = used.length > 1 ? used.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;

  const lede =
    t.swears === 0 || every === null
      ? `Not a single swear in ${num.format(t.prompts)} prompts.`
      : every === 1
        ? `Nearly every prompt cost you a coin. ${rate}`
        : `One prompt in ${num.format(every)} cost you a coin. ${rate}`;

  return (
    <header className="st-hero">
      <div className="cn-stack cn-gap-24">
        <h1 className="cn-display cn-m-0">
          {t.swears === 0 ? (
            <>
              Your swear jar is <em>empty</em>.
            </>
          ) : (
            <>
              You dropped <em>{coins(t.swears)}</em> in the swear jar.
            </>
          )}
        </h1>
        <p className="cn-lede cn-m-0">{lede}</p>
        <div className="st-stats">
          <div className="stat cn-p-0">
            <span>Salty prompts</span>
            <strong className="cn-text-text">{salty.toFixed(1)}%</strong>
          </div>
          <div className="stat cn-p-0">
            <span>Prompts</span>
            <strong className="cn-text-text">{num.format(t.prompts)}</strong>
          </div>
          <div className="stat cn-p-0">
            <span>Sessions</span>
            <strong className="cn-text-text">{num.format(t.sessions)}</strong>
          </div>
        </div>
        <p className="cn-meta cn-m-0">
          Taken {longDate.format(taken)}. The jar is emptied on{" "}
          {longDate.format(expires)}, when this link expires.
        </p>
      </div>

      <div className="st-stand">
        <Jar
          stack={stack}
          capacity={capacity}
          label={`${coins(t.swears)} in a jar that holds ${num.format(capacity)}`}
        />
        <div className="cn-stack cn-gap-12 st-key">
          <div className="cn-row cn-between cn-baseline cn-gap-12">
            <h2 className="cn-name cn-m-0">Who you swore at</h2>
            <span className="cn-label cn-nowrap">coins · rate</span>
          </div>
          <div className="cn-divide">
            {[...used].reverse().map((h) => (
              <div key={h.harness} className="stat is-inline">
                <span className="legend-item cn-name" style={vars({ "--tone": TONE[h.harness] })}>
                  {HARNESS_LABEL[h.harness]}
                </span>
                <span className="cn-meta cn-auto-l">{num.format(h.swears)}</span>
                <b className="cn-value">{h.rate.toFixed(1)}</b>
              </div>
            ))}
          </div>
          <p className="cn-meta cn-m-0">
            {worst && worst.swears > 0 &&
              `${HARNESS_LABEL[worst.harness]} takes the most, at ${worst.rate.toFixed(1)} per 100 prompts. `}
            Your jar holds {num.format(capacity)} coins.
          </p>
        </div>
        <div className="st-shelf" aria-hidden="true" />
      </div>
    </header>
  );
}

/** What is in the jar: the label on it, one row per word. */
function Contents({ report }: { report: Report }) {
  const words = report.top_words.slice(0, 12);
  const top = words[0];
  const max = Math.max(...words.map((w) => w.count), 1);
  const tiers = (["strong", "acronym", "medium", "mild"] as const).filter((tier) =>
    words.some((w) => w.tier === tier),
  );

  return (
    <section className="panel">
      <div className="panel-body cn-row cn-between cn-wrap cn-gap-16">
        <div>
          <h2 className="cn-title cn-m-0">What is in the jar</h2>
          <p className="cn-meta cn-mt-4 cn-mb-0">
            {top
              ? `${num.format(report.top_words.length)} distinct words. "${top.word}" alone is ${sharePercent(top.share)} of the jar.`
              : "Nothing yet."}
          </p>
        </div>
        {tiers.length > 0 && (
          <ul className="legend" aria-label="Tiers">
            {tiers.map((tier) => (
              <li key={tier} className="legend-item" style={vars({ "--tone": TIER_COLOR[tier] })}>
                {tier}
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Rows run edge to edge; the recipe rounds the last one into the
          panel corner. Focusable so the tip is reachable from the keyboard. */}
      {words.map((w, i) => (
        <div
          key={w.word}
          className="ranked-row st-word"
          tabIndex={0}
          data-tip={`${coins(w.count)}, ${w.tier}`}
        >
          <span className="cn-meta">{String(i + 1).padStart(2, "0")}</span>
          <strong className="cn-truncate">{w.word}</strong>
          <span
            className="progress-track cn-block"
            style={vars({ "--progress-fill": TIER_COLOR[w.tier] })}
          >
            <span style={{ width: `${(w.count / max) * 100}%` }} />
          </span>
          <b>{num.format(w.count)}</b>
          <span className="cn-meta cn-text-right">
            {sharePercent(w.share)}
            <span className="cn-sr-only"> of the jar, {w.tier}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * The agents' jar: a small jar with its own capacity, because agents almost
 * never swear and one coin should still be visible. The caption says how
 * much smaller it is than yours. It is the page's one tilted panel, because
 * it is the aside.
 */
function AgentJar({ report, capacity }: { report: Report; capacity: number }) {
  const a = report.agent;
  const small = jarCapacity(a.swears);
  const harnesses = report.agent_by_harness
    .filter((h) => h.messages > 0)
    .sort((x, y) => y.swears - x.swears);
  const words = report.agent_top_words.slice(0, 3);
  const verdict = agentVerdict(
    { swears: report.totals.swears, per100: report.totals.swears_per_100_prompts },
    { swears: a.swears, per100: a.swears_per_100_messages, messages: a.messages },
  );
  const said =
    words.length > 0
      ? ` It said ${words.map((w) => `${w.word} ${num.format(w.count)}`).join(", ")}.`
      : "";

  return (
    <aside className="panel is-tilted">
      <div className="panel-body st-agents">
        <div>
          <h2 className="cn-title cn-m-0">Does the agent swear back?</h2>
          <p className="cn-meta cn-mt-4 cn-mb-0">
            A much smaller jar. It holds {num.format(small)} coins, yours holds {num.format(capacity)}.
          </p>
        </div>
        <div className="st-shelved is-small">
          <Jar
            capacity={small}
            stack={harnesses.map((h) => ({ key: h.harness, n: h.swears, tone: TONE[h.harness] }))}
            label={`The agents' jar: ${coins(a.swears)} in a jar that holds ${num.format(small)}`}
          />
          <div className="st-shelf" aria-hidden="true" />
        </div>
        <div className="cn-stack cn-gap-16">
        <p className="cn-copy cn-m-0">
          {coins(a.swears)} in {num.format(a.messages)} replies. {verdict}
          {said}
        </p>
        {harnesses.length > 1 && (
          <dl className="kv">
            {harnesses.map((h) => (
              <Fragment key={h.harness}>
                <dt>{HARNESS_LABEL[h.harness]}</dt>
                <dd>
                  {num.format(h.swears)} in {num.format(h.messages)} replies
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
        </div>
      </div>
    </aside>
  );
}

/**
 * When the coins went in: one stack per calendar day, standing on a shelf in
 * a well. Your coins sit at the bottom in mauve, the agents' on top in their
 * harness colors. The coin shrinks when a heavy day would overflow the well,
 * so the tallest stack always fits and every stack keeps its proportion.
 */
function Deposits({ report }: { report: Report }) {
  const days = useMemo(
    () => depositDays(report.daily, report.agent_daily),
    [report.daily, report.agent_daily],
  );
  if (days.length === 0) return null;

  const active = days.filter((d) => d.prompts > 0).length;
  const peak = days.reduce((a, b) => (b.total > a.total ? b : a));
  const months = monthStarts(days);
  const agents = HARNESSES.filter((h) => days.some((d) => d.agents[h] > 0));
  const excluded = report.coverage.session_precision_prompts;
  // Gaps between stacks close up as the range grows, so a year still fits.
  const gap = days.length > 300 ? 0 : days.length > 150 ? 1 : 2;

  return (
    <section className="cn-stack cn-gap-16" aria-labelledby="st-deposits">
      <div className="cn-row cn-between cn-wrap cn-gap-16">
        <div>
          <h2 className="cn-title cn-m-0" id="st-deposits">
            When the coins went in
          </h2>
          <p className="cn-meta cn-mt-4 cn-mb-0">
            One coin per swear, one stack per day, {num.format(active)} active days.
            {peak.total > 0 &&
              ` The tallest stack is ${coins(peak.total)}, yours and the agents', on ${dayOf(peak.date)}.`}
            {excluded > 0 &&
              ` ${num.format(excluded)} Cursor prompts are dated by session, since Cursor keeps no per-message time.`}
          </p>
        </div>
        <ul className="legend" aria-label="Whose coins">
          <li className="legend-item" style={vars({ "--tone": "var(--mauve)" })}>
            You
          </li>
          {/* The hero's key uses these hues for where you typed. Here they
              are the agents' own swears, so the group says whose they are. */}
          {agents.length > 0 && <li className="legend-item st-legend-group">Agents</li>}
          {agents.map((h) => (
            <li key={h} className="legend-item" style={vars({ "--tone": TONE[h] })}>
              {HARNESS_LABEL[h]}
            </li>
          ))}
        </ul>
      </div>

      <div className="well cn-bg-well st-deposits">
        <div
          className="st-days"
          aria-hidden="true"
          style={vars({ "--max": Math.max(peak.total, 1), "--gap": `${gap}px` })}
        >
          {days.map((d, i) => {
            const tip =
              d.prompts === 0 && d.total === 0
                ? `${dayOf(d.date)}: no prompts`
                : `${dayOf(d.date)}: ${num.format(d.you)} in ${num.format(d.prompts)} prompts` +
                  (d.agentTotal > 0 ? `, ${num.format(d.agentTotal)} from the agents` : "");
            if (d.total === 0) {
              return <span key={d.date} className="is-quiet" data-tip={tip} />;
            }
            return (
              <span key={d.date} data-tip={tip} style={vars({ "--n": d.total, "--i": i })}>
                {[...HARNESSES].reverse().map(
                  (h) =>
                    d.agents[h] > 0 && (
                      <span
                        key={h}
                        className="st-coins"
                        style={vars({ "--n": d.agents[h], "--accent": TONE[h] })}
                      />
                    ),
                )}
                {d.you > 0 && (
                  <span
                    className="st-coins"
                    style={vars({ "--n": d.you, "--accent": "var(--mauve)" })}
                  />
                )}
              </span>
            );
          })}
        </div>
        <div className="st-shelf" aria-hidden="true" />
        <div className="st-months" aria-hidden="true">
          {months.map((m) => (
            <span
              key={m.index}
              className="cn-label"
              style={{ left: `${(m.index / days.length) * 100}%` }}
            >
              {m.month}
            </span>
          ))}
        </div>
      </div>

      {/* The stacks carry pointer tips only; this table carries the same
          days for screen readers. A table ignores the sr-only box size, so
          a wrapper carries it. */}
      <div className="cn-sr-only">
      <table>
        <caption>Swears per active day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Your swears</th>
            <th scope="col">Prompts</th>
            <th scope="col">Agent swears</th>
          </tr>
        </thead>
        <tbody>
          {days
            .filter((d) => d.prompts > 0 || d.total > 0)
            .map((d) => (
              <tr key={d.date}>
                <th scope="row">{dayOf(d.date)}</th>
                <td>{d.you}</td>
                <td>{d.prompts}</td>
                <td>{d.agentTotal}</td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

type SortKey = keyof Pick<ProjectStat, "name" | "prompts" | "swears" | "rate">;

const SHOWN = 15;

function Where({ report }: { report: Report }) {
  const [sort, setSort] = useState<SortKey>("swears");

  const rows = useMemo(() => {
    const copy = [...report.projects];
    copy.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b[sort] - a[sort],
    );
    return copy.slice(0, SHOWN);
  }, [report.projects, sort]);

  if (report.projects.length === 0) return null;

  const head: [SortKey, string][] = [
    ["name", "Project"],
    ["prompts", "Prompts"],
    ["swears", "Coins"],
    ["rate", "Per 100"],
  ];

  const total = report.projects.length;
  const note =
    total > SHOWN
      ? `Top ${SHOWN} of ${num.format(total)} projects.`
      : `${num.format(total)} ${total === 1 ? "project" : "projects"}.`;

  return (
    <section className="panel">
      <div className="panel-body">
        <h2 className="cn-title cn-m-0">Where the jar sat</h2>
        <p className="cn-meta cn-mt-4 cn-mb-0">{note}</p>
      </div>
      {/* The table fills the panel edge to edge and ends at its last row; the
          recipe rounds that row into the panel corners. Its cells carry no
          data-label, so on a phone it stays a table. */}
      <div className="table-scroll">
        <table className="data-table st-projects">
          <caption className="cn-sr-only">Swears per project, sortable</caption>
          <thead>
            <tr>
              {head.map(([key, label]) => (
                <th
                  key={key}
                  className={key === "name" ? "cn-text-left" : "cn-text-right"}
                  // Names sort A to Z; the counts sort largest first.
                  aria-sort={sort !== key ? "none" : key === "name" ? "ascending" : "descending"}
                >
                  <button type="button" onClick={() => setSort(key)}>
                    {label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.name}>
                <td className="cell-name cn-text-left">
                  <strong>{p.name}</strong>
                </td>
                <td className="cn-text-right">{num.format(p.prompts)}</td>
                <td className="cn-text-right">{num.format(p.swears)}</td>
                <td className="cn-text-right">{p.rate.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** On the page ground, under a rule: the fine print, not another panel. */
function Methodology({ report }: { report: Report }) {
  const c = report.coverage;
  const gb = (c.bytes_scanned / 1e9).toFixed(1);

  return (
    <footer className="st-method">
      <div className="cn-row cn-between cn-baseline cn-mb-12">
        <h2 className="cn-label cn-m-0">What was counted</h2>
        <span className="cn-code-meta">salt v{report.version}</span>
      </div>
      <ul className="cn-copy cn-m-0">
        <li>
          Scanned {num.format(c.files_scanned)} session files ({gb} GB) across
          Claude Code, Codex, and Cursor
          {c.files_failed > 0 &&
            `, ${num.format(c.files_failed)} unreadable and skipped`}
          . {num.format(c.duplicates_dropped)} duplicate messages collapsed
          before counting.
        </li>
        <li>
          Only prompts <em>you typed</em> count. Tool results, system reminders,
          slash-command envelopes, sub-agent delegations, and automation
          heartbeats are all excluded.
        </li>
        <li>
          Matching is word-bounded with an allowlist, and folds{" "}
          <code className="cn-code-inline">f*ck</code> and{" "}
          <code className="cn-code-inline">sh1t</code> onto their canonical spelling.
        </li>
        {c.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </footer>
  );
}
