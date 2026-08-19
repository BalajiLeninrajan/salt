import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    REPORTS: KVNamespace;
  }
}

const report = {
  version: "2",
  totals: { swears_per_100_prompts: 4.2, prompts: 1000, swears: 42 },
  top_words: [],
  by_harness: [],
};

function publish(body: BodyInit, headers: Record<string, string> = {}) {
  return SELF.fetch("https://example.com/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/publish", () => {
  it("stores a report and hands back its link", async () => {
    const res = await publish(JSON.stringify(report));
    expect(res.status).toBe(200);
    const out = await res.json<{ id: string; url: string; expires_in_days: number }>();
    expect(out.id).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
    expect(out.url).toBe(`https://example.com/r/${out.id}`);
    expect(out.expires_in_days).toBe(30);

    const read = await SELF.fetch(`https://example.com/api/report/${out.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toContain("application/json");
    expect(await read.json()).toEqual(report);
  });

  it("rejects other methods", async () => {
    const res = await SELF.fetch("https://example.com/api/publish");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("rejects non-JSON content types", async () => {
    const res = await publish("x", { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("rejects bodies over the cap by declared length", async () => {
    // fetch derives Content-Length from the string, so this exercises the
    // header check before the body is ever read.
    const res = await publish(`{"pad":"${"x".repeat(524288)}"}`);
    expect(res.status).toBe(413);
  });

  it("rejects oversized bodies that declare no length", async () => {
    // A streamed body is sent chunked with no Content-Length, so only the
    // count of actually received bytes can catch it.
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await publish(body);
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON", async () => {
    const res = await publish("{nope");
    expect(res.status).toBe(400);
  });

  it("rejects JSON that is not a report", async () => {
    const res = await publish(JSON.stringify({ version: "2" }));
    expect(res.status).toBe(422);
  });
});

describe("GET /api/report/:id", () => {
  it("404s an unknown id", async () => {
    const res = await SELF.fetch("https://example.com/api/report/0000000000");
    expect(res.status).toBe(404);
  });

  it("404s a malformed id", async () => {
    const res = await SELF.fetch("https://example.com/api/report/not-an-id");
    expect(res.status).toBe(404);
  });
});

describe("GET /r/:id", () => {
  it("serves the dashboard shell wired to the report", async () => {
    const id = "abc123defg";
    await env.REPORTS.put(id, JSON.stringify(report));

    const res = await SELF.fetch(`https://example.com/r/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    expect(html).toContain(`window.__SALT_REPORT_ID__="${id}"`);
    expect(html).toContain('<div id="root">');

    // The shell's own <title>salt</title> must be replaced, not shadowed.
    expect(html).toContain("<title>4.2 swears per 100 prompts — salt</title>");
    expect(html).not.toContain("<title>salt</title>");

    expect(html).toContain(
      '<meta property="og:title" content="4.2 swears per 100 prompts — salt"/>',
    );
    expect(html).toContain(
      '<meta property="og:description" content="42 swears across 1,000 prompts typed at coding agents."/>',
    );
    expect(html).toContain(`<meta property="og:url" content="https://example.com/r/${id}"/>`);
    // Text-only preview: a summary card and no image to fetch.
    expect(html).toContain('<meta name="twitter:card" content="summary"/>');
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("twitter:image");
  });

  it("serves the expired page for an unknown id", async () => {
    const res = await SELF.fetch("https://example.com/r/0000000000");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("This report is gone.");
    expect(html).toContain('href="/tokens.css"');
    expect(html).toContain('href="/styles.css"');
  });
});

describe("everything else", () => {
  it("falls through to the marketing page's assets", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("salt");

    const css = await SELF.fetch("https://example.com/tokens.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });
});
