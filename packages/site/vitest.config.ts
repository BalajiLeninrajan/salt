import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// The deployed ASSETS directory is Vite's build output, which tests can't
// assume exists. Stage the same content — the dashboard shell plus public/ —
// where ./test/wrangler.jsonc points. Done at config load because the pool
// validates the assets directory before any test hook runs.
const here = path.dirname(fileURLToPath(import.meta.url));
const staged = path.join(here, "test/.assets");
mkdirSync(staged, { recursive: true });
cpSync(path.join(here, "public"), staged, { recursive: true });
cpSync(path.join(here, "app.html"), path.join(staged, "app.html"));

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Miniflare provisions an in-memory REPORTS namespace from this
        // config; the real KV id is never touched by tests. The test config
        // mirrors ./wrangler.jsonc — see the comment there for why the
        // deployed one cannot be used directly.
        wrangler: { configPath: "./test/wrangler.jsonc" },
      },
    },
  },
});
