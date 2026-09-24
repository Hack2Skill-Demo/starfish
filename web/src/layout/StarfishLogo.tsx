/**
 * StarfishLogo — the Starfish mark (a pale star on a coral disc) and lockup.
 * The disc stays brand coral everywhere; `tone="dark"` switches the wordmark to
 * a light colour for dark surfaces.
 */
type Tone = "light" | "dark";

const CORAL = "#f25c2f"; // brand-500
const SHELL = "#fff4ef"; // brand-50
const INK = "#18181b"; // gray-900
const STAR = "M50 18 58.8 38.4 80.4 40.1 64 54.4 69 75.6 50 64.2 31 75.6 36 54.4 19.6 40.1 41.2 38.4Z";

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
      <path d={STAR} fill={SHELL} />
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
