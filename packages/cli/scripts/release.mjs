// Stages one npm package per platform binary under npm/, plus the `salt-ai`
// launcher package itself. Dry-run by default; `--publish` pushes them all.
//
// The platform packages exist only here: the workspace manifest carries no
// optionalDependencies on them (they would break every fresh install and CI
// lockfile check until published, and pull the binaries into dev installs),
// so they are injected into the staged `salt-ai` manifest at release time.
//
// Binaries come from one of two places:
//
//   --binaries <dir>   take prebuilt artifacts from <dir>/<triple>/salt[.exe]
//   (default)          build each target here with cargo
//
// CI uses the first, because cargo cannot cross-compile all six targets from a
// single runner the way `bun build --compile` could: the SQLite that rusqlite
// bundles is C, so each target wants its own C toolchain. A matrix of native
// runners is the cheap way to get that. Locally the default is useful for the
// host target and for the other macOS arch, which clang cross-compiles.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));

// The version lives in Cargo.toml now — that is what `cargo build` stamps into
// the binary via CARGO_PKG_VERSION, so anything else would be a second source
// of truth that could disagree with what users actually run.
const version = (() => {
  const toml = readFileSync(join(cliRoot, "Cargo.toml"), "utf8");
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) {
    console.error("could not read version from Cargo.toml");
    process.exit(1);
  }
  return m[1];
})();

// The launcher manifest carries its own version for npm's benefit, so the two
// can drift. They must not: the staged manifests are built from the Cargo
// version while a human reading package.json would believe otherwise.
if (manifest.version !== version) {
  console.error(
    `version mismatch: Cargo.toml has ${version}, package.json has ${manifest.version}`,
  );
  process.exit(1);
}

const TARGETS = [
  { pkg: "@salt-ai/darwin-arm64", triple: "aarch64-apple-darwin", os: ["darwin"], cpu: ["arm64"] },
  { pkg: "@salt-ai/darwin-x64", triple: "x86_64-apple-darwin", os: ["darwin"], cpu: ["x64"] },
  { pkg: "@salt-ai/linux-x64", triple: "x86_64-unknown-linux-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
  { pkg: "@salt-ai/linux-arm64", triple: "aarch64-unknown-linux-gnu", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
  { pkg: "@salt-ai/linux-x64-musl", triple: "x86_64-unknown-linux-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
  { pkg: "@salt-ai/win32-x64", triple: "x86_64-pc-windows-msvc", os: ["win32"], cpu: ["x64"] },
];

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed with status ${result.status}`);
    process.exit(1);
  }
}

const publishing = process.argv.includes("--publish");
const binariesFlag = process.argv.indexOf("--binaries");
const binariesDir = binariesFlag === -1 ? null : process.argv[binariesFlag + 1];
if (binariesFlag !== -1 && !binariesDir) {
  console.error("--binaries needs a directory");
  process.exit(1);
}

for (const target of TARGETS) {
  const pkgDir = join(cliRoot, "npm", target.pkg);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });

  const exe = target.os[0] === "win32" ? "salt.exe" : "salt";
  const binary = join(pkgDir, "bin", exe);

  if (binariesDir) {
    const built = join(binariesDir, target.triple, exe);
    if (!existsSync(built)) {
      // A missing artifact means a matrix leg failed. Publishing the rest
      // would leave the launcher pointing at a platform that does not exist.
      console.error(`missing binary for ${target.triple} at ${built}`);
      process.exit(1);
    }
    copyFileSync(built, binary);
  } else {
    run("cargo", ["build", "--release", "--target", target.triple], cliRoot);
    const built = join(cliRoot, "target", target.triple, "release", exe);
    if (!existsSync(built)) {
      console.error(`expected ${built} after building for ${target.triple}`);
      process.exit(1);
    }
    copyFileSync(built, binary);
  }
  // npm preserves the mode, but the artifact may arrive without the bit set —
  // a CI upload-artifact round trip drops it.
  if (target.os[0] !== "win32") chmodSync(binary, 0o755);

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: target.pkg,
        version: version,
        description: `${manifest.description} (prebuilt binary for ${target.os[0]}-${target.cpu[0]}${target.libc ? `, ${target.libc[0]}` : ""})`,
        license: manifest.license,
        // Provenance verification requires repository.url to match the repo
        // the workflow ran from.
        repository: manifest.repository,
        os: target.os,
        cpu: target.cpu,
        ...(target.libc ? { libc: target.libc } : {}),
        files: ["bin"],
        // Scoped packages default to private on first publish; be explicit.
        publishConfig: { access: "public" },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(pkgDir, "README.md"),
    `# ${target.pkg}\n\nPrebuilt \`salt\` binary for ${target.os[0]}-${target.cpu[0]}${target.libc ? ` (${target.libc[0]})` : ""}. Do not install this directly — install [salt-ai](https://www.npmjs.com/package/salt-ai), which picks the right binary for your platform.\n`,
  );

  const mb = (statSync(binary).size / 1e6).toFixed(1);
  console.log(`staged npm/${target.pkg} (${mb} MB, v${version})`);
}

// Stage the launcher package last so its optionalDependencies always match
// the platform packages built above.
const mainDir = join(cliRoot, "npm", "salt-ai");
mkdirSync(join(mainDir, "bin"), { recursive: true });
copyFileSync(join(cliRoot, "bin", "salt.mjs"), join(mainDir, "bin", "salt.mjs"));
copyFileSync(join(cliRoot, "..", "..", "README.md"), join(mainDir, "README.md"));
writeFileSync(
  join(mainDir, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: version,
      description: manifest.description,
      license: manifest.license,
      repository: manifest.repository,
      type: "module",
      bin: { salt: "bin/salt.mjs" },
      engines: manifest.engines,
      files: ["bin"],
      optionalDependencies: Object.fromEntries(TARGETS.map((t) => [t.pkg, version])),
    },
    null,
    2,
  ) + "\n",
);
console.log(`staged npm/salt-ai (launcher, v${version})`);

// A version already on the registry is done, not an error — this keeps the
// tag-triggered CI run green after a manual first publish, and makes a
// partially-failed run safe to rerun.
function alreadyPublished(name) {
  const probe = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() === version;
}

if (publishing) {
  for (const target of TARGETS) {
    if (alreadyPublished(target.pkg)) {
      console.log(`skip ${target.pkg}@${version} — already on the registry`);
      continue;
    }
    run("npm", ["publish"], join(cliRoot, "npm", target.pkg));
  }
  if (alreadyPublished(manifest.name)) {
    console.log(`skip ${manifest.name}@${version} — already on the registry`);
  } else {
    run("npm", ["publish"], mainDir);
  }
} else {
  console.log("dry run — pass --publish to push these to npm");
}
