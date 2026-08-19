import { useEffect, useMemo, useState } from "react";
import type { ProjectStat, Report } from "@salt/core";
import { HARNESS_COLOR, HARNESS_LABEL } from "@salt/core";
import { Heatmap, Timeline } from "./components/Charts";
import { Logo } from "./components/Logo";
import { ShareCard } from "./components/ShareCard";
import { WordList } from "./components/WordList";

const num = new Intl.NumberFormat("en-US");

declare global {
  interface Window {
    /** Seeded by the Worker into the HTML it serves for a published report. */
    __SALT_REPORT_ID__?: string;
  }
}

/**
 * This page has exactly one audience: someone who opened a link to a report
 * that another person ran and published. Everything here is written in the
 * third person for that reader, and nothing on it may promise that the numbers
 * never left a machine — the page is proof that they did.
 */
const REPORT_ID = typeof window === "undefined" ? undefined : window.__SALT_REPORT_ID__;

/** A published report is a snapshot; links are kept for 30 days after that. */
const LINK_TTL_DAYS = 30;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function snapshot(report: Report) {
  const generated = new Date(report.generated_at);
  const expires = new Date(generated.getTime() + LINK_TTL_DAYS * 86_400_000);
  return { generated: dateFmt.format(generated), expires: dateFmt.format(expires) };
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
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setReport)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <EmptyState />;
  if (!report) {
    return (
      <div className="shell">
        <div className="state">loading report…</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="page page-enter">
        <Hero report={report} />
        <ByHarness report={report} />
        <OtherSide report={report} />
        <Vocabulary report={report} />
        <OverTime report={report} />
        <When report={report} />
        <Where report={report} />
        <ShareCard report={report} shareUrl={window.location.href} />
        <Methodology report={report} />
      </div>
    </div>
  );
}

/** No id, or the id no longer resolves — reports expire on purpose. */
function EmptyState() {
  return (
    <div className="shell">
      <div className="state">
        <Logo className="state-logo" />
        <strong>this page carries no report</strong>
        <span>
          the link may have expired — reports live for {LINK_TTL_DAYS} days, then the
          numbers are gone for good
        </span>
      </div>
    </div>
  );
}

function Hero({ report }: { report: Report }) {
  const t = report.totals;
  const salty = t.prompts ? (100 * t.prompts_with_swear) / t.prompts : 0;
  const { generated, expires } = snapshot(report);

  return (
    <header className="hero">
      <section className="panel hero-main">
        <Logo className="hero-logo" />
        <p className="eyebrow">01 — Swears per 100 prompts</p>
        <p className="score">{t.swears_per_100_prompts.toFixed(1)}</p>
        <p className="score-caption">
          Across every Claude Code, Codex, and Cursor session on the machine that
          published this — {num.format(t.swears)} swears in {num.format(t.prompts)}{" "}
          prompts they typed.
        </p>
        <p className="snapshot">
          Snapshot taken {generated} · this link expires {expires}
        </p>
      </section>

      <section className="panel hero-card">
        <div className="stat-row">
          <span className="metric-label">Swears</span>
          <span className="metric-value">{num.format(t.swears)}</span>
        </div>
        <div className="stat-row">
          <span className="metric-label">Prompts</span>
          <span className="metric-value">{num.format(t.prompts)}</span>
        </div>
        <div className="stat-row">
          <span className="metric-label">Salty prompts</span>
          <span className="metric-value">{salty.toFixed(1)}%</span>
        </div>
        <div className="stat-row">
          <span className="metric-label">Sessions</span>
          <span className="metric-value">{num.format(t.sessions)}</span>
        </div>
      </section>
    </header>
  );
}

function ByHarness({ report }: { report: Report }) {
  const rows = report.by_harness;
  const max = Math.max(...rows.map((r) => r.rate), 0.0001);
  const worst = rows.reduce(
    (a, b) => (b.prompts > 0 && b.rate > (a?.rate ?? -1) ? b : a),
    rows[0],
  );

  return (
    <section className="panel">
      <p className="eyebrow">02 — By harness</p>
      <h2 className="section-title">Which agent gets it worst</h2>
      <p className="section-note">swears per 100 prompts</p>

      <div className="harness-grid">
        {rows.map((h) => (
          <article
            key={h.harness}
            className="harness-card"
            style={{ ["--entity-color" as string]: HARNESS_COLOR[h.harness] }}
          >
            <h3 className="harness-name">{HARNESS_LABEL[h.harness]}</h3>
            <div className="harness-rate">{h.rate.toFixed(1)}</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(h.rate / max) * 100}%` }} />
            </div>
            <div className="stat-row stat-row-sub">
              <span className="metric-label">Prompts</span>
              <span className="metric-value">{num.format(h.prompts)}</span>
            </div>
            <div className="stat-row stat-row-sub">
              <span className="metric-label">Swears</span>
              <span className="metric-value">{num.format(h.swears)}</span>
            </div>
          </article>
        ))}
      </div>

      {worst && worst.swears > 0 && (
        <p className="callout">
          <strong>{HARNESS_LABEL[worst.harness]}</strong> takes the most abuse —{" "}
          {worst.rate.toFixed(1)} swears per 100 prompts.
        </p>
      )}
    </section>
  );
}

function OtherSide({ report }: { report: Report }) {
  const a = report.agent;
  const words = report.agent_top_words.slice(0, 6);
  const userRate = report.totals.swears_per_100_prompts;
  // How many times more often the human swears, per message, than the agent.
  const ratio = a.swears_per_100_messages > 0 ? userRate / a.swears_per_100_messages : null;

  return (
    <section className="panel">
      <p className="eyebrow">03 — The other side</p>
      <h2 className="section-title">Does the agent swear back?</h2>
      <p className="section-note">
        visible replies only — never reasoning, tool calls, or compaction summaries
      </p>

      <div className="metric-grid">
        <div className="stat-row">
          <span className="metric-label">Replies</span>
          <span className="metric-value">{num.format(a.messages)}</span>
        </div>
        <div className="stat-row">
          <span className="metric-label">Swears</span>
          <span className="metric-value">{num.format(a.swears)}</span>
        </div>
        <div className="stat-row">
          <span className="metric-label">Per 100</span>
          <span className="metric-value">{a.swears_per_100_messages.toFixed(2)}</span>
        </div>
        <div className="stat-row">
          <span className="metric-label">Replies w/ swear</span>
          <span className="metric-value">{num.format(a.messages_with_swear)}</span>
        </div>
      </div>

      {report.agent_by_harness.length > 0 && (
        <div className="harness-grid">
          {report.agent_by_harness.map((h) => (
            <article
              key={h.harness}
              className="harness-card"
              style={{ ["--entity-color" as string]: HARNESS_COLOR[h.harness] }}
            >
              <h3 className="harness-name">{HARNESS_LABEL[h.harness]}</h3>
              <div className="harness-rate">{h.rate.toFixed(2)}</div>
              <div className="stat-row stat-row-sub">
                <span className="metric-label">Replies</span>
                <span className="metric-value">{num.format(h.messages)}</span>
              </div>
              <div className="stat-row stat-row-sub">
                <span className="metric-label">Swears</span>
                <span className="metric-value">{num.format(h.swears)}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {words.length > 0 && (
        <div className="section-gap">
          <WordList words={words} />
        </div>
      )}

      {a.swears === 0 ? (
        <p className="callout">
          The agent never swore once across {num.format(a.messages)} replies.
        </p>
      ) : (
        ratio !== null && (
          <p className="callout">
            They swear <strong>{ratio.toFixed(0)}×</strong> more often per message than
            the agent does — {userRate.toFixed(2)} against{" "}
            {a.swears_per_100_messages.toFixed(2)} per 100.
          </p>
        )
      )}
    </section>
  );
}

function Vocabulary({ report }: { report: Report }) {
  const words = report.top_words.slice(0, 12);

  return (
    <section className="panel">
      <p className="eyebrow">04 — Vocabulary</p>
      <h2 className="section-title">Top words</h2>
      <p className="section-note">the only place any prompt text appears</p>

      {words.length === 0 ? (
        <p className="section-note">no swears found — impressive.</p>
      ) : (
        <WordList words={words} />
      )}
    </section>
  );
}

function OverTime({ report }: { report: Report }) {
  return (
    <section className="panel">
      <p className="eyebrow">05 — Over time</p>
      <h2 className="section-title">Daily</h2>
      <p className="section-note">
        {report.daily.length} active days · their swears against the agent's, same scale
      </p>
      <Timeline daily={report.daily} agentDaily={report.agent_daily} />
    </section>
  );
}

function When({ report }: { report: Report }) {
  const excluded = report.coverage.session_precision_prompts;
  return (
    <section className="panel">
      <p className="eyebrow">06 — When</p>
      <h2 className="section-title">Hour of day, day of week</h2>
      {/* The buckets were cut on the publisher's machine, in whatever time zone
          it was set to. Calling that "local time" would read as the visitor's
          own, and shift every bar by however many hours separate them. */}
      <p className="section-note">
        shaded by swear rate · hours as the clock read on the machine that published this
        {excluded > 0 &&
          ` · ${num.format(excluded)} Cursor prompts excluded (session-level timestamps only)`}
      </p>
      <Heatmap cells={report.heatmap} />
    </section>
  );
}

type SortKey = keyof Pick<ProjectStat, "name" | "prompts" | "swears" | "rate">;

function Where({ report }: { report: Report }) {
  const [sort, setSort] = useState<SortKey>("swears");

  const rows = useMemo(() => {
    const copy = [...report.projects];
    copy.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b[sort] - a[sort],
    );
    return copy.slice(0, 15);
  }, [report.projects, sort]);

  const head: [SortKey, string][] = [
    ["name", "Project"],
    ["prompts", "Prompts"],
    ["swears", "Swears"],
    ["rate", "Per 100"],
  ];

  return (
    <section className="panel">
      <p className="eyebrow">07 — Where</p>
      <h2 className="section-title">Projects</h2>
      <p className="section-note">repository names only — the report carries no file paths</p>

      <div className="table-wrap">
        <table className="projects">
          <caption>Swear counts per project, sortable</caption>
          <thead>
            <tr>
              {head.map(([key, label]) => (
                <th key={key} aria-sort={sort === key ? "descending" : "none"}>
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
                <td className="cell-name">
                  <strong>{p.name}</strong>
                </td>
                <td>{num.format(p.prompts)}</td>
                <td>{num.format(p.swears)}</td>
                <td>{p.rate.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Methodology({ report }: { report: Report }) {
  const c = report.coverage;
  const gb = (c.bytes_scanned / 1e9).toFixed(1);
  const { generated, expires } = snapshot(report);

  return (
    <footer className="panel">
      <p className="eyebrow">09 — Methodology</p>
      <h2 className="section-title">What was counted</h2>
      <p className="section-note">salt v{report.version}</p>

      <ul className="methodology">
        <li>
          Scanned {num.format(c.files_scanned)} session files ({gb} GB) across Claude
          Code, Codex, and Cursor
          {c.files_failed > 0 && ` — ${num.format(c.files_failed)} unreadable and skipped`}
          . {num.format(c.duplicates_dropped)} duplicate messages collapsed before
          counting.
        </li>
        <li>
          Only prompts <em>they typed</em> count. Tool results, system reminders,
          slash-command envelopes, sub-agent delegations, and automation heartbeats are
          all excluded.
        </li>
        <li>
          Code is stripped before matching — fenced blocks, inline <code>backticks</code>,
          and file paths — so <code>assert</code> and <code>class</code> never register
          as swears.
        </li>
        <li>
          Matching is word-bounded with an allowlist, and folds <code>f*ck</code> /{" "}
          <code>sh1t</code> onto their canonical spelling.
        </li>
        {c.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>

      <p className="privacy">
        Counted on someone else's machine on {generated}, then published here. This page
        holds counts, matched words, and repository names — never the text of a prompt,
        and never a file path. Project names are directory basenames only. The link
        expires {expires}, {LINK_TTL_DAYS} days after it was published.
      </p>
    </footer>
  );
}
