# salt

[![salt-ai on npm](https://img.shields.io/npm/v/salt-ai.svg?label=salt-ai)](https://www.npmjs.com/package/salt-ai)
[![Node.js](https://img.shields.io/node/v/salt-ai.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/BalajiLeninrajan/salt/blob/main/LICENSE)

How much do you swear at your coding agents?

`salt` reads the session logs that Claude Code, Codex, and Cursor keep on your
machine, counts the swear words in the prompts you typed, and uploads the
counts as a report you can open in a browser and share.

```console
npx salt-ai
bunx salt-ai
```

Neither command installs anything on your PATH or in your project. The package
stays in the runner's cache.

The scan runs locally. By default salt then uploads the report, since the
dashboard only exists on the hosted site. It prints what it is about to upload
before sending it. Pass `--json` to skip the upload.

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

`--json` prints the same report to stdout and makes no network requests.

## Accuracy

Most of the work is deciding which text to ignore.

**Only what you typed counts.** Every harness routes machine-generated text
through the same channel as real prompts, so salt drops tool results, system
reminders, slash-command envelopes, sub-agent delegations, approval-assessment
transcripts, and automation heartbeats. Harnesses also rewrite a session's
entire history into a new file on every fork and resume. In the logs salt was
built against, one prompt showed up 405 times. salt counts each replayed prompt
once.

**Code never counts.** salt strips fenced blocks, inline backticks, and file
paths before matching, so `assert`, `class`, `pass`, and `analysis` cannot
register as swears. Matching is word-bounded against an allowlist on top of
that, and `f*ck` counts the same as the uncensored spelling.

The report's methodology section lists which files salt read and which it
couldn't.

## Custom lexicon

To change the word list, create `~/.config/salt/lexicon.toml`:

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
