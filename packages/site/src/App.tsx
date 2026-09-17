import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectStat, Report } from "@salt/core";
import { HARNESS_COLOR, HARNESS_LABEL, REPORT_TTL_DAYS, TIER_COLOR } from "@salt/core";
import { Calendar, Timeline } from "./components/Charts";
import { CopyLink } from "./components/CopyLink";
import { Logo } from "./components/Logo";
import { WordList } from "./components/WordList";

const num = new Intl.NumberFormat("en-US");

declare global {
  interface Window {
    /** Seeded by the Worker into the HTML it serves for a published report. */
    __SALT_REPORT_ID__?: string;
  }
}

/**
 * This page addresses the person who ran and published the report in the
 * second person ("you"), even though anyone with the link can view it.
 * Keep the copy about the numbers — data-handling details live in the
 * methodology footer, not sprinkled through every section.
 */
const REPORT_ID =
  typeof window === "undefined" ? undefined : window.__SALT_REPORT_ID__;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function snapshot(report: Report) {
  const generated = new Date(report.generated_at);
  const expires = new Date(generated.getTime() + REPORT_TTL_DAYS * 86_400_000);
  return {
    generated: dateFmt.format(generated),
    expires: dateFmt.format(expires),
  };
}

export default function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!REPORT_ID) {
      setFailed(true);
      return;
    }
    fetch(`/api/report/${REPORT_ID}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then(setReport)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <EmptyState />;
  if (!report) {
    return (
      <Frame>
        <div className="empty-state state">
          <span>loading report…</span>
        </div>
      </Frame>
    );
  }

  return (
    <Frame report={report}>
      <Hero report={report} />
      <ByHarness report={report} />
      <Vocabulary report={report} />
      <OtherSide report={report} />
      <OverTime report={report} />
      <Where report={report} />
      <Methodology report={report} />
    </Frame>
  );
}

/**
 * The page frame: a compact bar with the wordmark and the one action this
 * page has, then the page column. The bar is sticky, so the link is always
 * one click away no matter how far down the report the reader has got.
 */
function Frame({ report, children }: { report?: Report; children: ReactNode }) {
  const when = report && snapshot(report);
  return (
    <div className="app-shell" style={{ ["--page-width" as string]: "1080px" }}>
      <header className="topbar is-split is-compact">
        <a className="wordmark is-lg" href="/">
          <Logo />
        </a>
        {when && (
          <div className="cn-row cn-gap-12">
            <span className="cn-meta topbar-meta">
              Taken {when.generated} · link expires {when.expires}
            </span>
            <CopyLink url={window.location.href} />
          </div>
        )}
      </header>
      <main className="page-main page-enter cn-stack cn-gap-28">{children}</main>
    </div>
  );
}

/** No id, or the id no longer resolves — reports expire on purpose. */
function EmptyState() {
  return (
    <Frame>
      <div className="empty-state state">
        <strong>this page carries no report</strong>
        <span>
          the link may have expired. Reports live for {REPORT_TTL_DAYS} days,
          then the numbers are gone for good
        </span>
      </div>
    </Frame>
  );
}

/** Title and the one line under it that every panel opens with. */
function Heading({ title, note }: { title: string; note: ReactNode }) {
  return (
    <>
      <h2 className="cn-title cn-m-0">{title}</h2>
      <p className="cn-meta cn-mt-4 cn-mb-0">{note}</p>
    </>
  );
}

function Hero({ report }: { report: Report }) {
  const t = report.totals;
  const salty = t.prompts ? (100 * t.prompts_with_swear) / t.prompts : 0;
  // "One prompt in N" reads better than a percentage on a first screen.
  const every = t.prompts_with_swear ? Math.round(t.prompts / t.prompts_with_swear) : 0;
  const line =
    t.swears === 0
      ? `Not a single swear in ${num.format(t.prompts)} prompts.`
      : every <= 1
        ? "Nearly every prompt has a swear in it."
        : `One prompt in ${num.format(every)} has a swear in it.`;
  // With one harness there is no comparison to draw below, so the hero says
  // where the swearing went instead.
  const used = report.by_harness.filter((h) => h.prompts > 0);
  const where = used.length === 1 ? ` All of it at ${HARNESS_LABEL[used[0]!.harness]}.` : "";

  return (
    <header className="hero cn-grid-2 cn-gap-28">
      {/* The number sits on the page ground: a box around a single figure
          reads as a widget, not a headline. */}
      <section className="hero-main">
        <p className="eyebrow">Swears per 100 prompts</p>
        <p className="hero-number cn-text-text cn-m-0">
          {t.swears_per_100_prompts.toFixed(1)}
        </p>
        <p className="cn-lede cn-mt-12 cn-mb-0">{line + where}</p>
      </section>

      {/* Signature flourish via `panel is-tilted`; the stack is the package's. */}
      <section className="panel is-tilted cn-p-22 cn-stack cn-gap-16 hero-card">
        <div className="stat-row">
          <span className="cn-label">Swears</span>
          <span className="cn-value cn-text-text">{num.format(t.swears)}</span>
        </div>
        <div className="stat-row">
          <span className="cn-label">Prompts</span>
          <span className="cn-value cn-text-text">{num.format(t.prompts)}</span>
        </div>
        <div className="stat-row">
          <span className="cn-label">Salty prompts</span>
          <span className="cn-value cn-text-text">{salty.toFixed(1)}%</span>
        </div>
        <div className="stat-row">
          <span className="cn-label">Sessions</span>
          <span className="cn-value cn-text-text">{num.format(t.sessions)}</span>
        </div>
      </section>
    </header>
  );
}

function ByHarness({ report }: { report: Report }) {
  const rows = report.by_harness.filter((r) => r.prompts > 0);
  // One harness is not a comparison; the hero already names it.
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((r) => r.rate), 0.0001);
  const worst = rows.reduce((a, b) => (b.rate > a.rate ? b : a));

  // The finding is the subtitle. A banner restating what three cards already
  // show was one more box on a page that had too many.
  const note =
    worst.swears > 0
      ? `${HARNESS_LABEL[worst.harness]} takes the most abuse, at ${worst.rate.toFixed(1)} per 100 prompts`
      : "swears per 100 prompts";

  return (
    <section className="panel">
      <div className="panel-body">
        <Heading title="Which agent gets it worst" note={note} />
        <div className={`${rows.length >= 3 ? "cn-grid-3" : "cn-grid-2"} cn-gap-16 cn-mt-22`}>
          {rows.map((h) => (
            <article
              key={h.harness}
              className="accent-card harness-card"
              style={{ ["--entity-color" as string]: HARNESS_COLOR[h.harness] }}
            >
              <h3 className="cn-name harness-name cn-m-0 cn-mb-12">
                {HARNESS_LABEL[h.harness]}
              </h3>
              <div className="cn-value-lg">{h.rate.toFixed(1)}</div>
              <span className="progress-track cn-block cn-mt-12">
                <span
                  className="bar-fill"
                  style={{ width: `${(h.rate / max) * 100}%` }}
                />
              </span>
              <div className="stat-row cn-mt-12">
                <span className="cn-label">Prompts</span>
                <b>{num.format(h.prompts)}</b>
              </div>
              <div className="stat-row cn-mt-8">
                <span className="cn-label">Swears</span>
                <b>{num.format(h.swears)}</b>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Vocabulary({ report }: { report: Report }) {
  const words = report.top_words.slice(0, 12);
  const top = words[0];
  const note = top
    ? `${num.format(report.top_words.length)} distinct words · "${top.word}" alone is ${(top.share * 100).toFixed(0)}% of all swears`
    : "no swears found";

  return (
    <section className="panel">
      <div className="panel-body">
        <Heading title="Top words" note={note} />
      </div>
      {/* Rows run edge to edge; the recipe rounds the last one into the
          panel corner. */}
      {words.length > 0 && <WordList words={words} />}
    </section>
  );
}

function OtherSide({ report }: { report: Report }) {
  const a = report.agent;
  const words = report.agent_top_words.slice(0, 6);
  const harnesses = report.agent_by_harness.filter((h) => h.messages > 0);
  const userRate = report.totals.swears_per_100_prompts;
  // How many times more often the human swears, per message, than the agent.
  const ratio =
    a.swears_per_100_messages > 0 ? userRate / a.swears_per_100_messages : null;

  const note =
    a.swears === 0
      ? `not once, across ${num.format(a.messages)} visible replies`
      : ratio !== null && ratio >= 2
        ? `you swear ${ratio.toFixed(0)}× more often per message than it does · visible replies only`
        : "visible replies only";

  return (
    <section className="panel">
      <div className="panel-body">
        <Heading title="Does the agent swear back?" note={note} />

        {/* Four-up counter strip. A recessed readout carved from the panel,
            not a raised card: the well, at the soft depth. */}
        <div className="well cn-inset-soft cn-p-16 cn-grid-4 cn-mt-22 metric-grid">
          <div className="stat-row">
            <span className="cn-label">Replies</span>
            <span className="cn-value cn-text-text">{num.format(a.messages)}</span>
          </div>
          <div className="stat-row">
            <span className="cn-label">Swears</span>
            <span className="cn-value cn-text-text">{num.format(a.swears)}</span>
          </div>
          <div className="stat-row">
            <span className="cn-label">Per 100</span>
            <span className="cn-value cn-text-text">
              {a.swears_per_100_messages.toFixed(2)}
            </span>
          </div>
          <div className="stat-row">
            <span className="cn-label">Replies w/ swear</span>
            <span className="cn-value cn-text-text">
              {num.format(a.messages_with_swear)}
            </span>
          </div>
        </div>

        {/* Per harness as a strip of rows, not a second deck of cards: the
            cards above already carry the per-harness comparison that matters. */}
        {harnesses.length > 1 && (
          <div className="stat-strip cn-mt-16">
            {harnesses.map((h) => (
              <div key={h.harness} className="stat-row">
                <span className="cn-row">
                  <span
                    className="legend-dot"
                    style={{ background: HARNESS_COLOR[h.harness] }}
                  />
                  <span className="cn-name">{HARNESS_LABEL[h.harness]}</span>
                </span>
                <span className="cn-meta">
                  {num.format(h.swears)} in {num.format(h.messages)} replies
                  {" · "}
                  <b>{h.rate.toFixed(2)}</b> per 100
                </span>
              </div>
            ))}
          </div>
        )}

        {words.length > 0 && (
          <div className="cn-cluster cn-gap-8 cn-mt-16">
            <span className="cn-label">Its words</span>
            {words.map((w) => (
              <span
                key={w.word}
                className="chip-tone word-tier"
                style={{ ["--tier-color" as string]: TIER_COLOR[w.tier] }}
              >
                {w.word} · {num.format(w.count)}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function OverTime({ report }: { report: Report }) {
  const days = report.daily;
  if (days.length === 0) return null;
  const dates = days.map((d) => d.date).sort();
  const excluded = report.coverage.session_precision_prompts;

  return (
    <section className="panel">
      <div className="panel-body">
        <Heading
          title="Over time"
          note={`${num.format(days.length)} active days, ${dates[0]} to ${dates[dates.length - 1]} · your swears against the agent's, same scale`}
        />
        <div className="cn-mt-22">
          <Timeline daily={days} agentDaily={report.agent_daily} />
        </div>

        {/* Days were cut in the publisher's time zone — "your" days, in this
            page's voice, even when a visitor elsewhere is reading. */}
        <h3 className="cn-name cn-mt-28 cn-mb-4">Day by day</h3>
        <p className="cn-meta cn-mt-0 cn-mb-12">
          shaded by swear volume, weighted by severity · your local days
          {excluded > 0 &&
            ` · ${num.format(excluded)} Cursor prompts dated by session (no per-message time)`}
        </p>
        <Calendar daily={days} />
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

  const head: [SortKey, string][] = [
    ["name", "Project"],
    ["prompts", "Prompts"],
    ["swears", "Swears"],
    ["rate", "Per 100"],
  ];

  const total = report.projects.length;
  const note =
    total > SHOWN
      ? `top ${SHOWN} of ${num.format(total)} projects`
      : `${num.format(total)} projects`;

  return (
    <section className="panel">
      <div className="panel-body">
        <Heading title="Where it happens" note={note} />
      </div>
      {/* The table fills the panel edge to edge; the recipe rounds its last
          row into the panel corners. */}
      <div className="table-scroll">
        <table className="table-neu projects">
          <caption className="cn-sr-only">Swear counts per project, sortable</caption>
          <thead>
            <tr>
              {head.map(([key, label]) => (
                <th
                  key={key}
                  className={key === "name" ? "cn-text-left" : "cn-text-right"}
                  aria-sort={sort === key ? "descending" : "none"}
                >
                  <button onClick={() => setSort(key)}>
                    {label}
                    {sort === key ? " ↓" : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.name}>
                <td className="cell-name cn-text-left" data-label="Project">
                  <strong>{p.name}</strong>
                </td>
                <td className="cn-text-right" data-label="Prompts">{num.format(p.prompts)}</td>
                <td className="cn-text-right" data-label="Swears">{num.format(p.swears)}</td>
                <td className="cn-text-right" data-label="Per 100">{p.rate.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** On the page ground, under a rule: the fine print, not a tenth panel. */
function Methodology({ report }: { report: Report }) {
  const c = report.coverage;
  const gb = (c.bytes_scanned / 1e9).toFixed(1);

  return (
    <footer className="methodology">
      <div className="cn-row cn-between cn-baseline cn-mb-12">
        <h2 className="cn-label cn-m-0">What was counted</h2>
        <span className="cn-code-meta">salt v{report.version}</span>
      </div>
      <ul className="cn-copy cn-m-0 methodology-list">
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
          <code>f*ck</code> / <code>sh1t</code> onto their canonical spelling.
        </li>
        {c.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </footer>
  );
}
