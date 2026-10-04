/**
 * Guards the colour pairs written into the UI source: any class string that sets BOTH a
 * background and a text colour (with no variant prefix, so the light, resting state) must
 * reach WCAG AA 4.5:1. This is the cheap, always-on check; `pnpm audit:contrast` measures
 * what actually renders (page backgrounds, placeholders, icons, dark mode) and is the
 * authority. A pair that fails here is a defect the audit would also find.
 *
 * Colours come from styles/theme.css. Tailwind's zinc greys are not in that file, so a
 * table of their (v3) hex values stands in; they differ from the rendered v4 colours by
 * under 0.1 of a contrast ratio, which is why borderline greys are the audit's job.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `pnpm -C web test` runs from web/. (import.meta.url is not a file: URL under jsdom.)
const SRC = `${resolve(process.cwd(), "src")}/`;

const ZINC: Record<string, string> = {
  "50": "#fafafa", "100": "#f4f4f5", "200": "#e4e4e7", "300": "#d4d4d8", "400": "#a1a1aa",
  "500": "#71717a", "600": "#52525b", "700": "#3f3f46", "800": "#27272a", "900": "#18181b", "950": "#09090b",
};

/** `brand-700` → "#b63512", from theme.css; `gray-*` → the zinc table; `white`/`black`. */
function loadColors(): Map<string, string> {
  const css = readFileSync(`${SRC}styles/theme.css`, "utf8");
  const colors = new Map<string, string>([["white", "#ffffff"], ["black", "#000000"]]);
  for (const m of css.matchAll(/--color-([a-z]+-\d{2,3}):\s*(#[0-9a-fA-F]{6})\s*;/g)) colors.set(m[1]!, m[2]!);
  for (const [step, hex] of Object.entries(ZINC)) colors.set(`gray-${step}`, hex).set(`zinc-${step}`, hex);
  return colors;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(`${dir}${e.name}/`)
      : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
        ? [`${dir}${e.name}`]
        : []
  );
}

interface Pair { file: string; bg: string; text: string; classes: string }

/**
 * Every string literal that carries a resting-state bg-* AND text-* colour. Quoted literals
 * are scanned on their own, because the common case is one nested in a template literal
 * (`${active ? "bg-brand-700 text-white" : "..."}`) that a single pass would swallow whole;
 * template text is then scanned with its `${...}` expressions removed.
 */
function findPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const literals = [
      ...[...text.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!),
      ...[...text.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]!),
      ...[...text.matchAll(/`([^`]*)`/g)].map((m) => m[1]!.replace(/\$\{[^}]*\}/g, " ")),
    ];
    const seen = new Set<string>();
    for (const classes of literals) {
      if (seen.has(classes)) continue;
      seen.add(classes);
      const tokens = classes.split(/\s+/).filter((t) => t !== "" && !t.includes(":") && !t.includes("/"));
      const bg = tokens.find((t) => /^bg-(white|black|[a-z]+-\d{2,3})$/.test(t));
      const fg = tokens.find((t) => /^text-(white|black|[a-z]+-\d{2,3})$/.test(t));
      if (bg && fg) pairs.push({ file: file.replace(SRC, ""), bg: bg.slice(3), text: fg.slice(5), classes });
    }
  }
  return pairs;
}

describe("colour pairs written into the UI", () => {
  const colors = loadColors();
  const pairs = findPairs();

  it("finds the pairs it is meant to guard (a scan that matches nothing would pass forever)", () => {
    expect(pairs.length).toBeGreaterThan(10);
    const where = new Set(pairs.map((p) => p.file));
    for (const f of ["components/ui/Button.tsx", "components/ui/Badge.tsx", "pages/Incidents.tsx"]) {
      expect(where.has(f), `${f} has no bg+text pair found`).toBe(true);
    }
  });

  it("every light-mode background + text pair reaches AA 4.5:1", () => {
    const failures: string[] = [];
    for (const p of pairs) {
      const bg = colors.get(p.bg);
      const fg = colors.get(p.text);
      if (!bg || !fg) continue; // a colour outside the theme (e.g. a Tailwind default) isn't judged here
      const ratio = contrast(fg, bg);
      if (ratio < 4.5) failures.push(`${ratio.toFixed(2)}:1  ${p.file}  text-${p.text} on bg-${p.bg}   "${p.classes.slice(0, 70)}"`);
    }
    expect(failures).toEqual([]);
  });

  it("measures colours correctly: the pairs #30 reported as failing do fail", () => {
    // Known values (see issue #30), so a broken luminance formula can't make the guard vacuous.
    const r = (fg: string, bg: string) => +contrast(colors.get(fg)!, colors.get(bg)!).toFixed(2);
    expect(r("white", "brand-500")).toBe(3.31);
    expect(r("white", "brand-600")).toBe(4.3);
    expect(r("info-700", "info-100")).toBe(4.12);
    expect(r("white", "brand-700")).toBe(5.99);
  });
});
