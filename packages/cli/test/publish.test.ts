// The publishing path, against a stub endpoint on loopback.
//
// Publishing is the default path of the CLI, so the parts worth pinning are
// the ones a user actually collides with: the pre-flight size bail, the
// `SALT_HOST` override, and — the reason the endpoint bothers writing
// explanations at all — that a refusal's message survives the trip back.

import { describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";

import { host, publish } from "../src/publish";

/** Runs `f` with `SALT_HOST` set to `value` (or unset), then restores it. */
async function withHost<T>(value: string | undefined, f: () => T | Promise<T>): Promise<T> {
  const previous = process.env.SALT_HOST;
  if (value === undefined) delete process.env.SALT_HOST;
  else process.env.SALT_HOST = value;
  try {
    return await f();
  } finally {
    if (previous === undefined) delete process.env.SALT_HOST;
    else process.env.SALT_HOST = previous;
  }
}

interface Received {
  method: string;
  path: string;
  contentType: string | undefined;
  body: string;
}

interface Stub {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  base: string;
  requests: Received[];
  close: () => Promise<void>;
}

/** An HTTP endpoint that answers every request with exactly `status` and `body`. */
async function stub(status: number, contentType: string, body: string): Promise<Stub> {
  const requests: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A loopback port that is guaranteed to have nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A report body just past the 512 KiB cap the endpoint also enforces. */
function oversizedReport(): string {
  return `{"version":"1","pad":"${"x".repeat(512 * 1024)}"}`;
}

async function publishError(reportJson: string): Promise<string> {
  try {
    await publish(reportJson);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected publish to fail");
}

describe("publish", () => {
  test("host falls back to the hosted site", async () => {
    const resolved = await withHost(undefined, host);
    expect(resolved).toBe("https://salt.balajileninrajan.dev");
  });

  test("empty host is treated as unset", async () => {
    const resolved = await withHost("", host);
    expect(resolved).toBe("https://salt.balajileninrajan.dev");
  });

  test("host override drops trailing slashes", async () => {
    const resolved = await withHost("http://localhost:8787///", host);
    expect(resolved).toBe("http://localhost:8787");
  });

  test("oversized reports never leave the machine", async () => {
    const endpoint = await stub(200, "application/json", "{}");
    try {
      const message = await withHost(endpoint.base, () => publishError(oversizedReport()));
      expect(message).toContain("512 KB publishing limit");
      expect(message).toContain("--since");
      // The pre-flight bail must happen before anything is sent.
      expect(endpoint.requests).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  test("the endpoint's explanation reaches the user", async () => {
    const endpoint = await stub(413, "application/json", '{"error":"report exceeds 524288 bytes"}');
    try {
      const message = await withHost(endpoint.base, () => publishError('{"version":"1"}'));
      expect(message).toContain("report exceeds 524288 bytes");
      expect(message).toContain("413");
    } finally {
      await endpoint.close();
    }
  });

  test("a non-JSON refusal is reported raw", async () => {
    const endpoint = await stub(502, "text/html", "<h1>Bad gateway</h1>");
    try {
      const message = await withHost(endpoint.base, () => publishError('{"version":"1"}'));
      expect(message).toContain("Bad gateway");
      expect(message).toContain("502");
    } finally {
      await endpoint.close();
    }
  });

  test("an empty refusal still names the status", async () => {
    const endpoint = await stub(500, "text/plain", "");
    try {
      const message = await withHost(endpoint.base, () => publishError('{"version":"1"}'));
      expect(message).toContain("HTTP 500");
    } finally {
      await endpoint.close();
    }
  });

  test("a link comes back from a successful publish", async () => {
    const endpoint = await stub(
      200,
      "application/json",
      '{"id":"4emk3h6m46","url":"https://example.test/r/4emk3h6m46","expires_in_days":30}',
    );
    try {
      const published = await withHost(endpoint.base, () => publish('{"version":"1"}'));
      expect(published.url).toBe("https://example.test/r/4emk3h6m46");
      expect(published.expires_in_days).toBe(30);
    } finally {
      await endpoint.close();
    }
  });

  test("the request is JSON posted to the publish path", async () => {
    const endpoint = await stub(
      200,
      "application/json",
      '{"url":"https://example.test/r/x","expires_in_days":30}',
    );
    try {
      // A trailing slash on the override must not produce `//api/publish`.
      await withHost(`${endpoint.base}/`, () => publish('{"version":"1"}'));

      expect(endpoint.requests).toHaveLength(1);
      const request = endpoint.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/api/publish");
      expect(request.contentType?.toLowerCase()).toContain("application/json");
      expect(request.body).toBe('{"version":"1"}');
    } finally {
      await endpoint.close();
    }
  });

  test("a response without a link is an error", async () => {
    const endpoint = await stub(200, "application/json", '{"ok":true}');
    try {
      const message = await withHost(endpoint.base, () => publishError('{"version":"1"}'));
      expect(message).toContain("not a link");
    } finally {
      await endpoint.close();
    }
  });

  test("an unreachable endpoint says so", async () => {
    // A port that was just bound and released; nothing is listening.
    const port = await closedPort();
    const message = await withHost(`http://127.0.0.1:${port}`, () =>
      publishError('{"version":"1"}'),
    );
    expect(message).toContain("could not reach");
    expect(message).toContain("--json");
  });
});
