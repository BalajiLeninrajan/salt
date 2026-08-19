#!/usr/bin/env node
// Launcher: finds the prebuilt binary for this platform (shipped as an
// optional dependency) and hands over. Plain Node ≥16, no dependencies.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const TARGETS = [
  "@ai-salt/darwin-arm64",
  "@ai-salt/darwin-x64",
  "@ai-salt/linux-x64",
  "@ai-salt/linux-arm64",
  "@ai-salt/linux-x64-musl",
  "@ai-salt/win32-x64",
];

function targetPackage() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "@ai-salt/darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@ai-salt/darwin-x64";
  if (platform === "linux") {
    // glibcVersionRuntime is absent on musl-based distros (Alpine).
    const musl = !process.report?.getReport?.()?.header?.glibcVersionRuntime;
    if (arch === "x64") return musl ? "@ai-salt/linux-x64-musl" : "@ai-salt/linux-x64";
    if (arch === "arm64" && !musl) return "@ai-salt/linux-arm64";
  }
  if (platform === "win32" && arch === "x64") return "@ai-salt/win32-x64";
  return null;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const pkg = targetPackage();
if (!pkg) {
  fail(
    `ai-salt has no prebuilt binary for ${process.platform}-${process.arch}.\n` +
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
    `ai-salt could not find its binary package ${pkg}.\n` +
      `It ships as an optional dependency; installing with --no-optional (or with\n` +
      `optional dependencies disabled) breaks it. Reinstall ai-salt without that flag.`,
  );
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
