// Cross-compiles the CLI for every supported target and stages one npm
// package per binary under npm/, plus the `salt-ai` launcher package itself.
// Dry-run by default; `--publish` pushes them all.
//
// The platform packages exist only here: the workspace manifest carries no
// optionalDependencies on them (they would break every fresh install and CI
// lockfile check until published, and pull a 60MB+ binary into dev installs),
// so they are injected into the staged `salt-ai` manifest at release time.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));

const TARGETS = [
  { pkg: "@salt-ai/darwin-arm64", bun: "bun-darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
  { pkg: "@salt-ai/darwin-x64", bun: "bun-darwin-x64", os: ["darwin"], cpu: ["x64"] },
  { pkg: "@salt-ai/linux-x64", bun: "bun-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
  { pkg: "@salt-ai/linux-arm64", bun: "bun-linux-arm64", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
  { pkg: "@salt-ai/linux-x64-musl", bun: "bun-linux-x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
  { pkg: "@salt-ai/win32-x64", bun: "bun-windows-x64", os: ["win32"], cpu: ["x64"] },
];

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed with status ${result.status}`);
    process.exit(1);
  }
}

const publishing = process.argv.includes("--publish");

for (const target of TARGETS) {
  const pkgDir = join(cliRoot, "npm", target.pkg);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });

  const outfile = join(pkgDir, "bin", "salt");
  run("bun", ["build", "--compile", `--target=${target.bun}`, "src/main.ts", "--outfile", outfile], cliRoot);

  // Bun appends .exe to Windows binaries on its own.
  const binary = target.bun === "bun-windows-x64" ? `${outfile}.exe` : outfile;
  if (!existsSync(binary)) {
    console.error(`expected ${binary} after compiling for ${target.bun}`);
    process.exit(1);
  }

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: target.pkg,
        version: manifest.version,
        description: `${manifest.description} (prebuilt binary for ${target.os[0]}-${target.cpu[0]}${target.libc ? `, ${target.libc[0]}` : ""})`,
        license: manifest.license,
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
  console.log(`staged npm/${target.pkg} (${mb} MB, v${manifest.version})`);
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
      version: manifest.version,
      description: manifest.description,
      license: manifest.license,
      type: "module",
      bin: { salt: "bin/salt.mjs" },
      engines: manifest.engines,
      files: ["bin"],
      optionalDependencies: Object.fromEntries(TARGETS.map((t) => [t.pkg, manifest.version])),
    },
    null,
    2,
  ) + "\n",
);
console.log(`staged npm/salt-ai (launcher, v${manifest.version})`);

// A version already on the registry is done, not an error — this keeps the
// tag-triggered CI run green after a manual first publish, and makes a
// partially-failed run safe to rerun.
function alreadyPublished(name) {
  const probe = spawnSync("npm", ["view", `${name}@${manifest.version}`, "version"], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() === manifest.version;
}

if (publishing) {
  for (const target of TARGETS) {
    if (alreadyPublished(target.pkg)) {
      console.log(`skip ${target.pkg}@${manifest.version} — already on the registry`);
      continue;
    }
    run("npm", ["publish"], join(cliRoot, "npm", target.pkg));
  }
  if (alreadyPublished(manifest.name)) {
    console.log(`skip ${manifest.name}@${manifest.version} — already on the registry`);
  } else {
    run("npm", ["publish"], mainDir);
  }
} else {
  console.log("dry run — pass --publish to push these to npm");
}
