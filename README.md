# salt

How much do you swear at your coding agents?

`salt` reads the session logs that Claude Code, Codex, and Cursor already keep
on your machine, counts the profanity and insults in the prompts **you typed**,
and publishes the results to a private link you can open and share.

```console
npx saltai
bunx saltai
```

Nothing is added to your PATH or to your project — the runner caches the
download and that is the only trace it leaves.

The scan is local; the report is not. Publishing is the default and the only way
to see the dashboard. The tool prints what it is about to upload before it does,
and `--json` keeps everything on your machine.

## Options

| Option                 | Effect                                              |
| ---------------------- | --------------------------------------------------- |
| `--no-open`            | Do not launch a browser                             |
| `--harness <list>`     | Limit to `claude`, `codex`, `cursor`                |
| `--since <date\|span>` | Only count prompts since `2026-01-01` or `30d`      |
| `--json`               | Print the report to stdout and exit — no publishing |
| `--lexicon <path>`     | Use an alternate lexicon file                       |

## What gets published

The whole report is uploaded, **including your repository names**. Anyone with
the link can read it, and the link expires 30 days after it is created.

The report holds **counts and matched swear words** — never the text of your
prompts. Project names are reduced to the repository's directory name, so no
absolute paths are uploaded, and your home directory is never counted as a
project.

If you want a purely offline run, use `--json`. It scans, prints the report to
stdout, and exits without making a single network request — the same numbers the
dashboard would show, minus the dashboard.

## Accuracy

Counting profanity in developer prompts is mostly a filtering problem, and the
two hard parts are both handled explicitly.

**Only what you typed counts.** Every harness routes machine-generated text
through the same channel as real prompts. Tool results, system reminders,
slash-command envelopes, sub-agent delegations, approval-assessment transcripts,
and automation heartbeats are all excluded. Agent harnesses also rewrite a
session's entire history into a new file on every fork and resume — one prompt
appeared 405 times in the corpus this was built against — so replayed prompts
are collapsed to their first occurrence.

**Code never counts.** Fenced blocks, inline backticks, and file paths are
stripped before matching, so `assert`, `class`, `pass`, and `analysis` cannot
register as swears. Matching is word-bounded against an allowlist on top of that,
and folds `f*ck` onto its canonical spelling so evasion still counts.

Every number in the report's methodology section reports what was actually read,
including what could not be.

## Custom lexicon

Create `~/.config/salt/lexicon.toml`:

```toml
remove = ["hell"]          # stop counting these
allow  = ["cassowary"]     # never match inside these words

[add]
blast = "mild"             # word = mild | medium | strong | acronym
```

## Where it reads from

| Harness     | Location                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| Claude Code | `~/.claude/projects/**/*.jsonl`                                          |
| Codex       | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`  |
| Cursor      | `~/.cursor/chats/**/store.db` (opened read-only, immutable)              |

## How it ships

Everything is TypeScript. The CLI is compiled by Bun into a standalone
executable per platform — `saltai` on npm is a small launcher plus one
`saltai-<platform>` package per target, and `npm`/`pnpm`/`bun` install only the
one that matches your machine. All six targets cross-compile from a single
machine:

```console
cd packages/cli
node scripts/release.mjs            # stage all platform packages under npm/
node scripts/release.mjs --publish  # ...and publish them plus saltai itself
```

## Development

pnpm workspace, three packages:

| package         | what it is                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `packages/core` | the report schema shared by the CLI, the Worker, and the dashboard      |
| `packages/cli`  | the scanner/matcher/publisher, tested and compiled with Bun             |
| `packages/site` | the landing page, the report dashboard, and the Cloudflare Worker       |

```console
pnpm install
pnpm -r typecheck
cd packages/cli  && bun test          # scanner/matcher/report/publish suites
cd packages/site && pnpm test         # worker contract tests in real workerd
cd packages/site && pnpm dev          # landing page + dashboard + worker locally
cd packages/cli  && bun src/main.ts --json   # run the CLI from source
```

Point the CLI at a local worker with `SALT_HOST=http://localhost:5173`.

The site deploys through Cloudflare Workers Builds on push to `main` — no CI in
this repo. The v1 Rust implementation this was ported from is preserved as a
sibling checkout (`salt_old`); its test suite was carried over table-for-table,
and the TS port was audited against it module by module.

## License

MIT
