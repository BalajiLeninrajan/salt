# salt

[![salt-ai on npm](https://img.shields.io/npm/v/salt-ai.svg?label=salt-ai)](https://www.npmjs.com/package/salt-ai)
[![Node.js](https://img.shields.io/node/v/salt-ai.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/BalajiLeninrajan/salt/blob/main/LICENSE)

How much do you swear at your coding agents?

`salt` reads the session logs that Claude Code, Codex, and Cursor already keep
on your machine, counts the profanity in the prompts you typed, and publishes
the counts to a link you can open and share. A sodium panel for your terminal.

```console
npx salt-ai
bunx salt-ai
```

Nothing lands on your PATH or in your project. The runner caches the download,
and that is the only trace it leaves.

The scan is local; the report is not. Publishing is the default and the only
way to see the dashboard. The tool prints what it is about to upload before it
does, and `--json` keeps everything on your machine.

## Options

| Option                 | Effect                                           |
| ---------------------- | ------------------------------------------------ |
| `--no-open`            | Do not launch a browser                          |
| `--harness <list>`     | Limit to `claude`, `codex`, `cursor`             |
| `--since <date\|span>` | Only count prompts since `2026-01-01` or `30d`   |
| `--json`               | Print the report to stdout instead of publishing |
| `--lexicon <path>`     | Use an alternate lexicon file                    |

## What gets published

The whole report goes up, repository names included. Anyone with the link can
read it, and the link expires 30 days after it is created.

The report holds counts and matched swear words, never the text of your
prompts. Project names are cut down to the repository's directory name, so no
absolute paths leave your machine, and your home directory is never counted as
a project.

For a fully offline run, `--json` scans, prints the report to stdout, and exits
without making a single network request. Same numbers the dashboard would show,
minus the dashboard.

## Accuracy

Counting profanity in developer prompts is mostly a filtering problem. Two
things ruin the count if you let them.

**Only what you typed counts.** Every harness routes machine-generated text
through the same channel as real prompts, so salt drops tool results, system
reminders, slash-command envelopes, sub-agent delegations, approval-assessment
transcripts, and automation heartbeats. Harnesses also rewrite a session's
entire history into a new file on every fork and resume. One prompt appeared
405 times in the corpus this was built against. Replayed prompts collapse to
their first occurrence.

**Code never counts.** salt strips fenced blocks, inline backticks, and file
paths before matching, so `assert`, `class`, `pass`, and `analysis` cannot
register as swears. Matching is word-bounded against an allowlist on top of
that, and `f*ck` folds onto its canonical spelling, so censoring yourself
changes nothing.

The report's methodology section lists what was actually read, including what
could not be. No grain of salt required.

## Custom lexicon

Season to taste. Create `~/.config/salt/lexicon.toml`:

```toml
remove = ["hell"]          # stop counting these
allow  = ["cassowary"]     # never match inside these words

[add]
blast = "mild"             # word = mild | medium | strong | acronym
```

## Where it reads from

| Harness     | Location                                                                |
| ----------- | ----------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/**/*.jsonl`                                         |
| Codex       | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` |
| Cursor      | `~/.cursor/chats/**/store.db` (opened read-only, immutable)             |

## Development

pnpm workspace, three packages:

| package         | what it is                                                         |
| --------------- | ------------------------------------------------------------------ |
| `packages/core` | the report schema shared by the CLI, the Worker, and the dashboard |
| `packages/cli`  | the scanner/matcher/publisher, tested and compiled with Bun        |
| `packages/site` | the landing page, the report dashboard, and the Cloudflare Worker  |

```console
pnpm install
pnpm -r typecheck
cd packages/cli  && bun test          # scanner/matcher/report/publish suites
cd packages/site && pnpm test         # worker contract tests in real workerd
cd packages/site && pnpm dev          # landing page + dashboard + worker locally
cd packages/cli  && bun src/main.ts --json   # run the CLI from source
```

Point the CLI at a local worker with `SALT_HOST=http://localhost:5173`.
