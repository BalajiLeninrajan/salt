import { useEffect, useRef, useState } from "react";
import type { Report, Tier } from "@salt/core";
import { ARCH, SIDE_BEARING, X_HEIGHT } from "./Logo";

const num = new Intl.NumberFormat("en-US");

/** Card geometry: the standard 1200×630 unfurl, drawn at 2× for retina. */
const CARD_W = 1200;
const CARD_H = 630;
const SCALE = 2;

// Canvas can't read CSS custom properties, so the Mocha hexes are pinned here.
const MOCHA = {
  crust: "#11111b",
  surface0: "#313244",
  overlay1: "#7f849c",
  overlay2: "#9399b2",
  subtext1: "#bac2de",
  text: "#cdd6f4",
  mauve: "#cba6f7",
  lavender: "#b4befe",
  yellow: "#f9e2af",
  red: "#f38ba8",
  peach: "#fab387",
};

const TIER_HEX: Record<Tier, string> = {
  mild: MOCHA.overlay2,
  medium: MOCHA.yellow,
  strong: MOCHA.red,
  acronym: MOCHA.peach,
};

const SANS = "Inter, sans-serif";
const MONO = "'JetBrains Mono', monospace";

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The wordmark, laid out from the same ARCH numbers as the on-page logo. */
function drawWordmark(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseline: number,
  size: number,
) {
  const xh = X_HEIGHT * size;
  const sb = SIDE_BEARING * size;
  const scale = xh / ARCH.height;

  ctx.font = `700 ${size}px ${SANS}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MOCHA.text;
  ctx.fillText("s", x, baseline);

  const ax = x + ctx.measureText("s").width + sb;
  ctx.save();
  ctx.translate(ax, baseline - xh);
  ctx.scale(scale, scale);
  ctx.strokeStyle = MOCHA.text;
  ctx.lineWidth = ARCH.stroke;
  ctx.stroke(new Path2D(ARCH.path));
  ctx.fillStyle = MOCHA.lavender;
  ctx.beginPath();
  ctx.arc(ARCH.dot.cx, ARCH.dot.cy, ARCH.dot.r, 0, Math.PI * 2);
  ctx.fill();
  roundedRect(ctx, ARCH.stem.x, ARCH.stem.y, ARCH.stem.w, ARCH.stem.h, ARCH.stem.rx);
  ctx.fill();
  ctx.restore();

  ctx.font = `700 ${size}px ${SANS}`;
  ctx.fillStyle = MOCHA.text;
  ctx.fillText("lt", ax + ARCH.width * scale + sb, baseline);
}

function letterSpacing(ctx: CanvasRenderingContext2D, px: number) {
  // Not in the CanvasRenderingContext2D type everywhere yet; a silent no-op
  // where unsupported.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

function draw(canvas: HTMLCanvasElement, report: Report) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const t = report.totals;

  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);

  ctx.fillStyle = MOCHA.crust;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Ambient mauve bloom, top-left — same wash the page shell carries.
  const bloom = ctx.createRadialGradient(160, 40, 0, 160, 40, 760);
  bloom.addColorStop(0, "rgba(203, 166, 247, 0.06)");
  bloom.addColorStop(1, "rgba(203, 166, 247, 0)");
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  drawWordmark(ctx, 72, 118, 58);

  ctx.fillStyle = MOCHA.text;
  ctx.font = `800 200px ${SANS}`;
  letterSpacing(ctx, -10);
  ctx.fillText(t.swears_per_100_prompts.toFixed(1), 62, 356);
  letterSpacing(ctx, 0);

  ctx.fillStyle = MOCHA.mauve;
  ctx.font = `700 22px ${MONO}`;
  letterSpacing(ctx, 3);
  ctx.fillText("SWEARS PER 100 PROMPTS", 72, 408);
  letterSpacing(ctx, 0);

  ctx.fillStyle = MOCHA.overlay1;
  ctx.font = `600 19px ${MONO}`;
  ctx.fillText(
    `${num.format(t.swears)} swears · ${num.format(t.prompts)} prompts · ${num.format(t.sessions)} sessions`,
    72,
    462,
  );

  // Top words as tier-tinted chips along the bottom.
  let cx = 72;
  const cy = 548;
  ctx.font = `700 20px ${MONO}`;
  for (const w of report.top_words.slice(0, 5)) {
    const tw = ctx.measureText(w.word).width;
    const pad = 16;
    const cw = tw + pad * 2;
    if (cx + cw > CARD_W - 72) break;
    const tone = TIER_HEX[w.tier];
    ctx.fillStyle = `${tone}14`;
    roundedRect(ctx, cx, cy, cw, 44, 10);
    ctx.fill();
    ctx.strokeStyle = `${tone}66`;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, cx, cy, cw, 44, 10);
    ctx.stroke();
    ctx.fillStyle = tone;
    ctx.fillText(w.word, cx + pad, cy + 29);
    cx += cw + 12;
  }

  ctx.fillStyle = MOCHA.overlay1;
  ctx.font = `700 16px ${MONO}`;
  ctx.textAlign = "right";
  ctx.fillText(new Date(report.generated_at).toISOString().slice(0, 10), CARD_W - 72, 118);
  ctx.textAlign = "left";
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas toBlob failed"))),
      "image/png",
    ),
  );
}

type CopyState = "idle" | "copied" | "failed";

export function ShareCard({ report, shareUrl }: { report: Report; shareUrl: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pngState, setPngState] = useState<CopyState>("idle");
  const [linkState, setLinkState] = useState<CopyState>("idle");

  useEffect(() => {
    let cancelled = false;
    // The card is text-heavy; drawing before Inter and JetBrains Mono arrive
    // would bake fallback glyphs into the bitmap. fonts.ready alone only covers
    // faces the DOM already used, so the canvas-only cuts are loaded explicitly.
    const faces = [
      `700 58px ${SANS}`,
      `800 200px ${SANS}`,
      `700 22px ${MONO}`,
    ];
    document.fonts.ready
      .then(() => Promise.all(faces.map((f) => document.fonts.load(f))))
      .catch(() => {})
      .then(() => {
        if (!cancelled && canvasRef.current) draw(canvasRef.current, report);
      });
    return () => {
      cancelled = true;
    };
  }, [report]);

  function flash(set: (s: CopyState) => void, state: CopyState) {
    set(state);
    setTimeout(() => set("idle"), 1800);
  }

  function copyPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      // The promise goes into ClipboardItem directly: Safari only allows the
      // write when it starts inside the user gesture, before the blob exists.
      const item = new ClipboardItem({ "image/png": toBlob(canvas) });
      navigator.clipboard.write([item]).then(
        () => flash(setPngState, "copied"),
        () => flash(setPngState, "failed"),
      );
    } catch {
      flash(setPngState, "failed");
    }
  }

  async function downloadPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const url = URL.createObjectURL(await toBlob(canvas));
      const a = document.createElement("a");
      a.href = url;
      a.download = "salt-card.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch {
      flash(setPngState, "failed");
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(shareUrl).then(
      () => flash(setLinkState, "copied"),
      () => flash(setLinkState, "failed"),
    );
  }

  return (
    <section className="panel">
      <p className="eyebrow">08 — Share</p>
      <h2 className="section-title">Share card</h2>
      <p className="section-note">rate, top words, nothing else — safe to post anywhere</p>

      <div className="chart-well share-well">
        <canvas
          ref={canvasRef}
          className="share-canvas"
          role="img"
          aria-label={`${report.totals.swears_per_100_prompts.toFixed(1)} swears per 100 prompts`}
        />
      </div>

      <div className="share-actions">
        <button className="btn" onClick={copyPng}>
          {pngState === "copied" ? "Copied" : pngState === "failed" ? "Copy failed" : "Copy PNG"}
        </button>
        <button className="btn btn-ghost" onClick={downloadPng}>
          Download PNG
        </button>
      </div>

      <div className="share-url">
        <code>{shareUrl}</code>
        <button className="btn btn-ghost btn-small" onClick={copyLink}>
          {linkState === "copied" ? "Copied" : linkState === "failed" ? "Failed" : "Copy link"}
        </button>
      </div>
    </section>
  );
}
