import { useEffect, useRef, useState } from "react";

type State = "idle" | "copied" | "failed";

/**
 * Puts text on the clipboard and holds the result for 1800ms, then reverts.
 * Only which state shows changes; nothing animates the swap.
 */
function useCopy(text: string) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function flash(next: State) {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }

  function copy() {
    navigator.clipboard.writeText(text).then(
      () => flash("copied"),
      () => flash("failed"),
    );
  }

  return [state, copy] as const;
}

function CopyGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" />
    </svg>
  );
}

function DoneGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const LINK_LABEL: Record<State, string> = {
  idle: "Copy link",
  copied: "Copied",
  failed: "Copy failed",
};

/** The report's one action: put its own URL on the clipboard. */
export function CopyLink({ url }: { url: string }) {
  const [state, copy] = useCopy(url);
  return (
    <button className="btn btn-primary is-sm" onClick={copy} aria-live="polite">
      {state === "copied" ? <DoneGlyph /> : <CopyGlyph />}
      {LINK_LABEL[state]}
    </button>
  );
}

/**
 * The package's .command recipe: both glyphs are in the markup, and
 * .is-copied on the row decides which one shows and turns the button green.
 */
export function CopyCommand({ command }: { command: string }) {
  const [state, copy] = useCopy(command);
  const tip = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return (
    <div className={`command${state === "copied" ? " is-copied" : ""}`}>
      <code className="command-text">
        <span className="command-prompt">$</span>
        {command}
      </code>
      <button
        type="button"
        className="btn is-icon command-copy"
        onClick={copy}
        data-tip={tip}
        aria-label={state === "idle" ? "Copy the command" : tip}
      >
        <CopyGlyph className="copy-glyph" />
        <DoneGlyph className="done-glyph" />
      </button>
    </div>
  );
}
