/**
 * What PostHog must not see from a report page. The id in /r/<id> is the only
 * thing keeping a report unlisted, and the page's title is the report's own
 * totals. Kept free of React and the DOM so the Worker's test pool can check
 * it directly.
 *
 * public/index.html carries a plain-JS copy of the URL half: arriving there
 * from a report puts the report's link in the referrer.
 */
import type { CaptureResult, Properties } from "posthog-js";

const REPORT_PATH = /^\/r\/[^/]+/;

/**
 * Replaces the id in a report link on `origin` with `:id`, for absolute URLs
 * and bare paths alike. Anything else, including /r/ paths on other sites,
 * comes back as it was.
 */
export function redactUrl(value: string, origin: string): string {
  const relative = value.startsWith("/");
  if (!relative && !value.startsWith("http")) return value;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return value;
  }
  if (url.origin !== origin || !REPORT_PATH.test(url.pathname)) return value;
  url.pathname = url.pathname.replace(REPORT_PATH, "/r/:id");
  return relative ? url.pathname + url.search + url.hash : url.href;
}

// Walks nested objects and arrays too: $web_vitals puts the page URL inside
// each metric ($web_vitals_LCP_event.$current_url, .navigationURL, ...).
function redactValue(value: unknown, origin: string): unknown {
  if (typeof value === "string") return redactUrl(value, origin);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, origin));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    redactProps(value as Properties, origin);
  }
  return value;
}

function redactProps(props: Properties, origin: string): void {
  for (const [key, value] of Object.entries(props)) props[key] = redactValue(value, origin);
}

/** A `before_send` hook, given the page's origin. */
export function redactEvent(event: CaptureResult | null, origin: string): CaptureResult | null {
  if (!event) return event;
  const props = event.properties;
  redactProps(props, origin);
  if (event.$set) redactProps(event.$set, origin);
  if (event.$set_once) redactProps(event.$set_once, origin);
  // Heatmap clicks arrive grouped under the URL they happened on.
  if (props.$heatmap_data) {
    props.$heatmap_data = Object.fromEntries(
      Object.entries(props.$heatmap_data).map(([url, clicks]) => [redactUrl(url, origin), clicks]),
    );
  }
  delete props.title;
  return event;
}
