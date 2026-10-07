import { describe, expect, it } from "vitest";
import type { CaptureResult } from "posthog-js";
import { redactEvent, redactUrl } from "../src/redact";

const ORIGIN = "https://salt.balajileninrajan.dev";

describe("redactUrl", () => {
  it("hides the id in this site's report links", () => {
    expect(redactUrl(`${ORIGIN}/r/0123456789`, ORIGIN)).toBe(`${ORIGIN}/r/:id`);
    expect(redactUrl(`${ORIGIN}/r/0123456789/?x=1#top`, ORIGIN)).toBe(`${ORIGIN}/r/:id/?x=1#top`);
    expect(redactUrl("/r/0123456789", ORIGIN)).toBe("/r/:id");
  });

  it("leaves other pages and other sites alone", () => {
    expect(redactUrl(`${ORIGIN}/`, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(redactUrl("/api/report/0123456789", ORIGIN)).toBe("/api/report/0123456789");
    expect(redactUrl("https://www.reddit.com/r/rust", ORIGIN)).toBe("https://www.reddit.com/r/rust");
    expect(redactUrl("Copy link", ORIGIN)).toBe("Copy link");
  });
});

describe("redactEvent", () => {
  it("strips the report from every property PostHog would send", () => {
    const event = {
      uuid: "u",
      event: "$pageview",
      properties: {
        $current_url: `${ORIGIN}/r/0123456789`,
        $pathname: "/r/0123456789",
        $referrer: "$direct",
        title: "12.3 swears per 100 prompts, salt",
        $heatmap_data: { [`${ORIGIN}/r/0123456789`]: [{ x: 1, y: 2 }] },
      },
      $set_once: { $initial_current_url: `${ORIGIN}/r/0123456789` },
    } as CaptureResult;

    const out = redactEvent(event, ORIGIN)!;
    expect(JSON.stringify(out)).not.toContain("0123456789");
    expect(out.properties.title).toBeUndefined();
    expect(out.properties.$referrer).toBe("$direct");
    expect(Object.keys(out.properties.$heatmap_data)).toEqual([`${ORIGIN}/r/:id`]);
  });

  it("reaches the URLs nested inside web vitals metrics", () => {
    const event = {
      uuid: "u",
      event: "$web_vitals",
      properties: {
        $current_url: `${ORIGIN}/r/0123456789`,
        $web_vitals_LCP_value: 1200,
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 1200,
          $current_url: `${ORIGIN}/r/0123456789`,
          navigationURL: `${ORIGIN}/r/0123456789`,
          attribution: { url: `${ORIGIN}/r/0123456789`, target: "main" },
        },
      },
    } as CaptureResult;

    const out = redactEvent(event, ORIGIN)!;
    expect(JSON.stringify(out)).not.toContain("0123456789");
    expect(out.properties.$web_vitals_LCP_event.navigationURL).toBe(`${ORIGIN}/r/:id`);
    expect(out.properties.$web_vitals_LCP_event.attribution).toEqual({ url: `${ORIGIN}/r/:id`, target: "main" });
    expect(out.properties.$web_vitals_LCP_value).toBe(1200);
  });

  it("passes a dropped event through", () => {
    expect(redactEvent(null, ORIGIN)).toBeNull();
  });
});
