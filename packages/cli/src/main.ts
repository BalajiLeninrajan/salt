import { parseCliArgs, usage } from "./args.js";
import { additions, loadOverrides } from "./lexicon.js";
import { Matcher } from "./match.js";
import { openUrl } from "./open.js";
import { host, publish } from "./publish.js";
import { buildReport } from "./report.js";
import { scan } from "./scan/index.js";
import { parseSince } from "./since.js";
import { ALL_HARNESSES, UsageError } from "./types.js";
import { makeUi } from "./ui.js";
import { VERSION } from "./version.js";

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.version) {
    console.log(`salt-ai ${VERSION}`);
    return;
  }

  const harnesses = args.harnesses.length === 0 ? ALL_HARNESSES : args.harnesses;
  // Argument problems must surface before a multi-second scan starts.
  const since = args.since !== undefined ? parseSince(args.since) : undefined;
  const overrides = loadOverrides(args.lexicon);
  const matcher = new Matcher({
    add: additions(overrides),
    remove: overrides.remove,
    allow: overrides.allow,
  });

  if (args.json) {
    const out = await scan(harnesses);
    if (since !== undefined) out.messages = out.messages.filter((p) => p.ts >= since);
    const report = buildReport(out.messages, out.stats, matcher);
    console.log(JSON.stringify(report));
    return;
  }

  const ui = makeUi();
  ui.intro("salt — how much do you swear at your coding agents?");

  const spinner = ui.spinner();
  spinner.start("Reading local sessions…");
  const started = Date.now();
  const out = await scan(harnesses, (p) => {
    spinner.message(`${p.files}/${p.totalFiles} files · ${gb(p.bytes)} GB`);
  });
  // The since filter runs after dedup on purpose: a replayed prompt's earliest
  // occurrence may predate the cutoff, and collapsing first keeps it out.
  if (since !== undefined) out.messages = out.messages.filter((p) => p.ts >= since);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  spinner.stop(
    `Scanned ${out.stats.files_scanned} files (${gb(out.stats.bytes_scanned)} GB) in ${elapsed}s — ${out.messages.length} messages.`,
  );

  const report = buildReport(out.messages, out.stats, matcher);
  const json = JSON.stringify(report);

  // Publishing is the only path to the dashboard, so it says plainly what is
  // about to leave the machine. The project names are the part worth naming
  // out loud — nothing else in the report identifies anything.
  ui.log(
    `Publishing to ${host()} — ${report.totals.prompts} prompts, ${report.projects.length} projects by name, no prompt text.`,
  );

  const published = await publish(json);
  ui.outro(
    `${published.url}\nAnyone with the link can read it. It expires in ${published.expires_in_days} days.`,
  );
  if (!args.noOpen) openUrl(published.url);
}

try {
  await run();
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
