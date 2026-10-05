/**
 * StarfishLogo — the Starfish mark (a pale starfish on a coral disc) and lockup.
 * The disc stays brand coral everywhere; `tone="dark"` switches the wordmark to
 * a light colour for dark surfaces.
 */
type Tone = "light" | "dark";

const CORAL = "#f25c2f"; // brand-500
const SHELL = "#fff4ef"; // brand-50
const INK = "#18181b"; // gray-900
const STARFISH =
  "M46.4 22.8Q50 14 53.6 22.8L57.7 32.9Q59.4 37.1 63.7 37.4L74.2 38.4Q83.3 39.2 76.4 45.2L68.5 52.1Q65.2 54.9 66.3 59.3L68.9 69.9Q71.2 79.1 63.1 74.1L53.8 68.4Q50 66 46.4 68.1L37.6 73.1Q30 77.5 31.8 68.9L33.9 59Q34.8 54.9 31.5 52.1L23.6 45.2Q16.7 39.2 25.8 38.4L36.3 37.4Q40.6 37.1 42.3 32.9Z";

export function StarfishLogo({
  variant = "mark",
  tone = "light",
  size = 32,
  title = "Starfish",
}: {
  variant?: "mark" | "lockup";
  tone?: Tone;
  size?: number;
  title?: string;
}) {
  const wordmark = tone === "dark" ? SHELL : INK;
  const decorative = !title;
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
    >
      {!decorative && <title>{title}</title>}
      <circle cx="50" cy="50" r="48" fill={CORAL} />
      <path d={STARFISH} fill={SHELL} />
      <circle cx="47" cy="45" r="2" fill={CORAL} opacity="0.65" />
      <circle cx="54" cy="49" r="1.6" fill={CORAL} opacity="0.65" />
      <circle cx="48" cy="55" r="1.4" fill={CORAL} opacity="0.65" />
    </svg>
  );
  if (variant === "mark") return mark;
  return (
    <span className="inline-flex items-center gap-3">
      {mark}
      <span className="font-display text-2xl font-bold" style={{ color: wordmark }}>
        Starfish
      </span>
    </span>
  );
}
