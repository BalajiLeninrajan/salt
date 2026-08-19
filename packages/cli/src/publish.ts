// Publishing a report to the hosted site.
//
// This is the default path, so it is also the moment the tool stops being
// local-only. Everything the report holds — including the project names —
// leaves the machine here, which is why the caller prints what is going and
// where before this returns a link.

/**
 * Where reports are published.
 *
 * Overridable so a `wrangler dev` session can be targeted without a rebuild:
 * `SALT_HOST=http://localhost:8787 saltai`.
 */
const DEFAULT_HOST = "https://salt.balajileninrajan.dev";

/**
 * Matches the Worker's own cap. Checking here turns a 413 from the far end
 * into an explanation before anything is sent.
 */
const MAX_BODY_BYTES = 512 * 1024;

export interface Published {
  url: string;
  expires_in_days: number;
}

export function host(): string {
  const env = process.env.SALT_HOST;
  const h = env !== undefined && env !== "" ? env : DEFAULT_HOST;
  return h.replace(/\/+$/, "");
}

export async function publish(reportJson: string): Promise<Published> {
  const bytes = Buffer.byteLength(reportJson);
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `this report is ${Math.floor(bytes / 1024)} KB, over the ${MAX_BODY_BYTES / 1024} KB publishing limit — narrow it with --since and try again, or use --json`,
    );
  }

  const endpoint = `${host()}/api/publish`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reportJson,
    });
  } catch {
    // A transport failure here is almost always the network or a typo'd
    // SALT_HOST, and the raw error says neither.
    throw new Error(`could not reach ${endpoint} — check your connection, or use --json`);
  }

  const status = response.status;
  const body = await response.text();

  if (status < 200 || status >= 300) {
    // The endpoint answers with `{"error": "..."}`; anything else (a proxy
    // error page, an empty body) is reported raw rather than swallowed.
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error === "string") detail = parsed.error;
    } catch {
      // keep the raw body
    }
    detail = detail.trim();
    if (detail === "") {
      throw new Error(`${endpoint} rejected the report with HTTP ${status}`);
    }
    throw new Error(`${endpoint} rejected the report (HTTP ${status}): ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const p = parsed as { url?: unknown; expires_in_days?: unknown } | null;
  if (!p || typeof p.url !== "string" || typeof p.expires_in_days !== "number") {
    throw new Error("the publishing endpoint returned something that is not a link");
  }
  return { url: p.url, expires_in_days: p.expires_in_days };
}
