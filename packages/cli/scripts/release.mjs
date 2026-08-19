// Cross-compiles the CLI for every supported target and stages one npm
// package per binary under npm/. Dry-run by default; `--publish` pushes each
// platform package and then `saltai` itself.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));

const TARGETS = [
  { pkg: "saltai-darwin-arm64", bun: "bun-darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
  { pkg: "saltai-darwin-x64", bun: "bun-darwin-x64", os: ["darwin"], cpu: ["x64"] },
  { pkg: "saltai-linux-x64", bun: "bun-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
  { pkg: "saltai-linux-arm64", bun: "bun-linux-arm64", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
  { pkg: "saltai-linux-x64-musl", bun: "bun-linux-x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
  { pkg: "saltai-win32-x64", bun: "bun-windows-x64", os: ["win32"], cpu: ["x64"] },
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
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(pkgDir, "README.md"),
    `# ${target.pkg}\n\nPrebuilt \`salt\` binary for ${target.os[0]}-${target.cpu[0]}${target.libc ? ` (${target.libc[0]})` : ""}. Do not install this directly — install [saltai](https://www.npmjs.com/package/saltai), which picks the right binary for your platform.\n`,
  );

  const mb = (statSync(binary).size / 1e6).toFixed(1);
  console.log(`staged npm/${target.pkg} (${mb} MB, v${manifest.version})`);
}

if (publishing) {
  for (const target of TARGETS) {
    run("npm", ["publish"], join(cliRoot, "npm", target.pkg));
  }
  run("npm", ["publish"], cliRoot);
} else {
  console.log("dry run — pass --publish to push these to npm");
}
