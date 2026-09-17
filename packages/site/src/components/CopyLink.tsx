import { useEffect, useRef, useState } from "react";

type State = "idle" | "copied" | "failed";

const LABEL: Record<State, string> = {
  idle: "Copy link",
  copied: "Copied",
  failed: "Copy failed",
};

/** The page's one action: put its own URL on the clipboard. */
export function CopyLink({ url }: { url: string }) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function flash(next: State) {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }

  function copy() {
    navigator.clipboard.writeText(url).then(
      () => flash("copied"),
      () => flash("failed"),
    );
  }

  return (
    <button className="btn btn-primary is-sm" onClick={copy} aria-live="polite">
      {state === "copied" ? (
        <svg
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
      ) : (
        <svg
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
      )}
      {LABEL[state]}
    </button>
  );
}
