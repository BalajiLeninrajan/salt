/**
 * The salt wordmark: "salt" set in Inter, with the `a` replaced by an arch
 * holding a lowercase `i` — so it reads as an A, and the mark contains both
 * letters of AI without spelling anything but "salt".
 *
 * Only the arch is drawn. The other three letters are real text, so they pick
 * up Inter's own shapes, weight, and hinting rather than an approximation of
 * them.
 */

/**
 * Arch geometry, on a grid where 100 = the x-height and the origin is the
 * x-height line. The bottom of the arch sits on the baseline, so it aligns with
 * the surrounding text without any nudging.
 *
 * The numbers are measured off Inter Bold as it actually rasterises, not taken
 * from a spec: an `l` stem is 0.150em, an `n` is 0.50em of ink, the x-height is
 * 0.550em, and the sidebearing is 0.060em. Against the x-height that makes the
 * stroke 27 and the width 91 here. Guessing these produced an arch that was too
 * wide and too light to pass as a letter.
 */
export const X_HEIGHT = 0.55;
export const SIDE_BEARING = 0.06;

export const ARCH = {
  width: 91,
  height: 100,
  stroke: 27,
  path: "M 13.5 100 L 13.5 45.5 A 32 32 0 0 1 77.5 45.5 L 77.5 100",
  dot: { cx: 45.5, cy: 44, r: 8.5 },
  stem: { x: 37, y: 59, w: 17, h: 41, rx: 8.5 },
};

const INK = "#b4befe"; // --lavender

function Arch({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${ARCH.width} ${ARCH.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <path d={ARCH.path} fill="none" stroke="currentColor" strokeWidth={ARCH.stroke} />
      <circle cx={ARCH.dot.cx} cy={ARCH.dot.cy} r={ARCH.dot.r} fill={INK} />
      <rect
        x={ARCH.stem.x}
        y={ARCH.stem.y}
        width={ARCH.stem.w}
        height={ARCH.stem.h}
        rx={ARCH.stem.rx}
        fill={INK}
      />
    </svg>
  );
}

/** The wordmark. Size it with `font-size` on the element or its parent. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`logo ${className ?? ""}`.trim()} role="img" aria-label="salt">
      s<Arch className="logo-a" />lt
    </span>
  );
}
