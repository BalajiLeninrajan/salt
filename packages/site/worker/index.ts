/**
 * salt's hosted reports.
 *
 * The CLI publishes a report here and gets back a link. Opening that link
 * serves the same dashboard bundle that runs locally.
 *
 * Anything this Worker does not claim falls through to the marketing site's
 * static assets, which is still the bulk of what lives here.
 */
import type { Report } from "@salt/core";

interface Env {
  REPORTS: KVNamespace;
  ASSETS: Fetcher;
}

/** Reports expire on their own; there is no delete path and nothing to sweep. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

/** Generous for a report, small enough that nobody stores a filesystem in KV. */
const MAX_BODY_BYTES = 512 * 1024;

const ID_LENGTH = 10;
/**
 * Crockford base32 minus the letters it treats as ambiguous, so an id survives
 * being read aloud or retyped. 32^10 is ~50 bits: unguessable, which is the
 * only thing keeping an unlisted report unlisted.
 */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

const ID_RE = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/publish") {
      return request.method === "POST"
        ? publish(request, env, url)
        : new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const api = path.match(/^\/api\/report\/([^/]+)$/);
    if (api) return readReport(api[1], env);

    const page = path.match(/^\/r\/([^/]+)\/?$/);
    if (page) return reportPage(page[1], env, url);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Accepts a report and hands back its link.
 *
 * Validation is deliberately shallow — enough to keep the store full of things
 * that are actually reports, not enough to be an authorization layer. This is
 * an open endpoint by design; the practical ceiling is KV's daily write quota.
 */
async function publish(request: Request, env: Env, url: URL): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    return problem(415, "send application/json");
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return problem(413, `report exceeds ${MAX_BODY_BYTES} bytes`);
  }

  // Content-Length is a claim, not a guarantee — a chunked upload sends none
  // at all — so this is the check that counts. It has to be taken on the raw
  // bytes: `String.prototype.length` counts UTF-16 code units, and a report
  // full of non-ASCII project names is up to three bytes per unit, which would
  // let a body several times the cap through.
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return problem(413, `report exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const body = new TextDecoder().decode(raw);

  let report: Report;
  try {
    report = JSON.parse(body) as Report;
  } catch {
    return problem(400, "body is not valid JSON");
  }
  if (!looksLikeReport(report)) {
    return problem(422, "body is not a salt report");
  }

  const id = newId();
  await env.REPORTS.put(id, body, { expirationTtl: TTL_SECONDS });

  return Response.json({
    id,
    url: `${url.origin}/r/${id}`,
    expires_in_days: TTL_SECONDS / 86400,
  });
}

/**
 * The shape the dashboard actually reads. A report missing any of these
 * renders as a broken page rather than an error, which is worse than refusing
 * it here.
 */
function looksLikeReport(value: unknown): value is Report {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Report>;
  return (
    typeof r.version === "string" &&
    typeof r.totals?.swears_per_100_prompts === "number" &&
    typeof r.totals?.prompts === "number" &&
    typeof r.totals?.swears === "number" &&
    Array.isArray(r.top_words) &&
    Array.isArray(r.by_harness)
  );
}

async function loadReport(id: string, env: Env): Promise<Report | null> {
  if (!ID_RE.test(id)) return null;
  return await env.REPORTS.get<Report>(id, "json");
}

async function readReport(id: string, env: Env): Promise<Response> {
  if (!ID_RE.test(id)) return problem(404, "no such report");
  const body = await env.REPORTS.get(id, "text");
  if (body === null) return problem(404, "this report has expired or never existed");
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Immutable for its whole life: a published report is never rewritten.
      "cache-control": "public, max-age=3600",
    },
  });
}

/**
 * The dashboard, with the preview tags a crawler needs.
 *
 * The shell is fetched from the built bundle rather than hand-written so Vite's
 * hashed asset filenames stay intact without this Worker having to know them.
 */
async function reportPage(id: string, env: Env, url: URL): Promise<Response> {
  const report = await loadReport(id, env);
  if (!report) return expiredPage(url);

  const shell = await env.ASSETS.fetch(new URL("/app.html", url.origin));
  if (!shell.ok) return problem(500, "dashboard bundle is missing from this deploy");
  const html = await shell.text();

  const t = report.totals;
  const title = `${t.swears_per_100_prompts.toFixed(1)} swears per 100 prompts — salt`;
  const description =
    `${t.swears.toLocaleString("en-US")} swears across ` +
    `${t.prompts.toLocaleString("en-US")} prompts typed at coding agents.`;

  // The bundle's shell already ships `<title>salt</title>`, and HTML resolves
  // to the *first* title element in tree order — appending a second one would
  // leave every report tab, bookmark, and title-scraper reading the generic
  // name. Overwrite the shell's title rather than adding to it.
  const titleTag = `<title>${escapeHtml(title)}</title>`;
  const shellTitle = /<title[^>]*>[\s\S]*?<\/title>/i;
  const titled = shellTitle.test(html)
    ? html.replace(shellTitle, () => titleTag)
    : html.replace("</head>", () => `${titleTag}</head>`);

  const head = `
    <meta name="description" content="${escapeHtml(description)}"/>
    <meta property="og:type" content="website"/>
    <meta property="og:title" content="${escapeHtml(title)}"/>
    <meta property="og:description" content="${escapeHtml(description)}"/>
    <meta property="og:url" content="${url.origin}/r/${id}"/>
    <meta name="twitter:card" content="summary"/>
    <meta name="twitter:title" content="${escapeHtml(title)}"/>
    <meta name="twitter:description" content="${escapeHtml(description)}"/>
    <script>window.__SALT_REPORT_ID__=${JSON.stringify(id)}</script>
  `;

  return new Response(titled.replace("</head>", () => `${head}</head>`), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

/** A dead link should explain itself rather than 404 into the marketing page. */
function expiredPage(url: URL): Response {
  const html = `<!doctype html><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Report not found — salt</title>
<link rel="icon" href="/favicon.svg"/>
<link rel="stylesheet" href="/tokens.css"/>
<link rel="stylesheet" href="/styles.css"/>
<main style="max-width:34rem;margin:18vh auto;padding:0 1.5rem">
  <h1>This report is gone.</h1>
  <p>Published reports expire after 30 days. If it was yours, run
     <code>salt</code> again to publish a fresh one.</p>
  <p><a href="${url.origin}/">What is salt?</a></p>
</main>`;
  return new Response(html, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
  );
}
