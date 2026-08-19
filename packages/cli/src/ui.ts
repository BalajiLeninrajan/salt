// Terminal output, in two voices: clack frames when a human is watching, and
// plain stderr lines (the v1 style) when output is piped or captured.

import * as clack from "@clack/prompts";

export interface Spinner {
  start(msg: string): void;
  message(msg: string): void;
  stop(msg: string): void;
}

export interface Ui {
  intro(msg: string): void;
  spinner(): Spinner;
  log(msg: string): void;
  outro(msg: string): void;
}

function clackUi(): Ui {
  return {
    intro: (msg) => clack.intro(msg),
    spinner: () => {
      const s = clack.spinner();
      return {
        start: (msg) => s.start(msg),
        message: (msg) => s.message(msg),
        stop: (msg) => s.stop(msg),
      };
    },
    log: (msg) => clack.log.info(msg),
    outro: (msg) => clack.outro(msg),
  };
}

function plainUi(): Ui {
  const eprintln = (msg: string) => process.stderr.write(`${msg}\n`);
  return {
    intro: () => {},
    spinner: () => ({
      start: eprintln,
      message: () => {},
      stop: eprintln,
    }),
    log: eprintln,
    // v1 printed the link and its expiry to stdout, where scripts expect it.
    outro: (msg) => process.stdout.write(`${msg}\n`),
  };
}

export function makeUi(): Ui {
  return process.stderr.isTTY ? clackUi() : plainUi();
}
