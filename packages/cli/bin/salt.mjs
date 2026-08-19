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
process.exit(result.status ?? 1);
