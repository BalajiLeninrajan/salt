import { parseArgs } from "node:util";
import { type Harness, parseHarness, UsageError } from "./types.js";

export interface Args {
  json: boolean;
  noOpen: boolean;
  help: boolean;
  version: boolean;
  harnesses: Harness[];
  since?: string;
  lexicon?: string;
}

export function parseCliArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        harness: { type: "string", multiple: true },
        since: { type: "string" },
        lexicon: { type: "string" },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }

  return {
    json: values.json ?? false,
    noOpen: values["no-open"] ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    harnesses: (values.harness ?? []).flatMap((v) => v.split(",")).map(parseHarness),
    since: values.since,
    lexicon: values.lexicon,
  };
}

export function usage(): string {
  return `salt — how much do you swear at your coding agents?

Usage: salt [options]

Options:
  --no-open              Do not launch a browser
  --harness <list>       Limit to claude, codex, cursor (comma-separated)
  --since <date|span>    Only count prompts since 2026-01-01 or 30d
  --json                 Print the report JSON to stdout and exit — nothing is published
  --lexicon <path>       Use an alternate lexicon file
  --help                 Show this help
  --version              Show the version`;
}
