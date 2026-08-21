#!/usr/bin/env node
// Launcher: finds the prebuilt binary for this platform (shipped as an
// optional dependency) and hands over. Plain Node ≥16, no dependencies.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const TARGETS = [
  "@salt-ai/darwin-arm64",
  "@salt-ai/darwin-x64",
  "@salt-ai/linux-x64",
  "@salt-ai/linux-arm64",
  "@salt-ai/linux-x64-musl",
  "@salt-ai/win32-x64",
];

function targetPackage() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "@salt-ai/darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@salt-ai/darwin-x64";
  if (platform === "linux") {
    // glibcVersionRuntime is absent on musl-based distros (Alpine).
    const musl = !process.report?.getReport?.()?.header?.glibcVersionRuntime;
    if (arch === "x64") return musl ? "@salt-ai/linux-x64-musl" : "@salt-ai/linux-x64";
    if (arch === "arm64" && !musl) return "@salt-ai/linux-arm64";
  }
  if (platform === "win32" && arch === "x64") return "@salt-ai/win32-x64";
  return null;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const pkg = targetPackage();
if (!pkg) {
  fail(
    `salt has no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Supported targets: ${TARGETS.join(", ")}.`,
  );
}

let binary;
try {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve(`${pkg}/package.json`));
  binary = join(root, "bin", process.platform === "win32" ? "salt.exe" : "salt");
} catch {
  fail(
    `salt could not find its binary package ${pkg}.\n` +
      `It ships as an optional dependency; installing with --no-optional (or with\n` +
      `optional dependencies disabled) breaks it. Reinstall salt-ai without that flag.`,
  );
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

// A binary that is present but will not run — exec bit lost by a packing tool,
// wrong architecture, quarantined by Gatekeeper — used to surface as a bare
// exit 1 with nothing printed, which is indistinguishable from salt itself
// failing. Say what actually happened.
if (result.error) {
  fail(
    `salt could not run its binary at ${binary}.\n` +
      `${result.error.message}\n` +
      `If it was installed correctly this usually means the file lost its\n` +
      `executable bit, or the download is for a different architecture.`,
  );
}

// Killed by a signal: report it the way a shell would, so Ctrl-C is 130 rather
// than an indistinguishable 1.
if (result.signal) {
  const signals = { SIGINT: 130, SIGTERM: 143, SIGQUIT: 131 };
  process.exit(signals[result.signal] ?? 1);
}

process.exit(result.status ?? 1);
