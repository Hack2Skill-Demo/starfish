#!/usr/bin/env node
/* global document, getComputedStyle, NodeFilter */
/**
 * Contrast audit of the RENDERED operator UI: for every element that directly holds
 * text, the colour against its effective background (translucent layers composited
 * down the ancestor chain), plus placeholder text and icon strokes, in light and dark.
 * Reports anything under WCAG 2.1 AA: 4.5:1 for text, 3:1 for large text (>= 24px, or
 * >= 18.66px bold) and for icons. Disabled controls and the logo mark are exempt, as
 * WCAG exempts them.
 *
 * Why this and not a class-name grep: what a screen shows depends on Tailwind's
 * resolved colours, the page background behind a card, and states a grep can't see.
 * (web/src/lib/contrast.test.ts guards the colour pairs written into the source; this
 * checks what actually renders.)
 *
 * Run (needs Java for the emulators, and a Chromium):
 *   pnpm dev:emulated                       # in one terminal: seeded emulators + UI on :5177
 *   CHROMIUM_PATH=/path/to/chromium pnpm audit:contrast
 * `CHROMIUM_PATH` is optional if Playwright's own browser is installed. `STARFISH_UI_URL`
 * overrides http://localhost:5177. Exits 1 when anything fails.
 *
 * Guests: a fresh browser context with no sign-in is audited too (Anonymous sign-in must be
 * enabled; the Auth emulator allows it).
 *
 * Not covered: hover, focus and error/loading states that can't be reached with the seeded
 * data, and anything outside the screens listed at the bottom.
 */
import { chromium } from "playwright-core";

const base = process.env.STARFISH_UI_URL ?? "http://localhost:5177";
const launchOptions = { args: ["--no-sandbox"], ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }) };

const AUDIT = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  // Modern Chrome may report oklch()/color(); canvas normalises any CSS colour to rgb.
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const norm = (c) => { cv.clearRect(0,0,1,1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0,0,1,1);
    const d = cv.getImageData(0,0,1,1).data; return { r: d[0], g: d[1], b: d[2], a: d[3]/255 }; };
  const toRgb = (c) => { const p = parse(c); return p ?? norm(c); };
  const over = (top, bottom) => { const a = top.a + bottom.a*(1-top.a);
    if (a === 0) return {r:255,g:255,b:255,a:0};
    const f = (t,b) => (t*top.a + b*bottom.a*(1-top.a))/a;
    return { r: f(top.r,bottom.r), g: f(top.g,bottom.g), b: f(top.b,bottom.b), a }; };
  const lum = ({r,g,b}) => { const f = (c) => { c/=255; return c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const ratio = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
  const bgOf = (el) => {
    const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const e of chain.reverse()) {
      const cs = getComputedStyle(e);
      const c = toRgb(cs.backgroundColor);
      if (c.a > 0) bg = over(c, bg);
    }
    return bg;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    if (el.closest("[disabled],[aria-disabled=true]")) continue;       // disabled controls are exempt
    let fg = toRgb(cs.color);
    const bg = bgOf(el);
    fg = over(fg, bg);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) out.push({ text: n.textContent.trim().slice(0,40), got: +got.toFixed(2), need, cls: (el.className||"").toString().slice(0,90), tag: el.tagName.toLowerCase() });
  }
  // Non-text UI components (icons, borders on controls) need 3:1: check svg icons' stroke.
  for (const svg of document.querySelectorAll("svg")) {
    if (svg.closest("[disabled]")) continue;
    if (svg.closest('a[aria-label="Starfish home"]')) continue;   // the logo mark is exempt
    const r = svg.getBoundingClientRect(); if (r.width === 0) continue;
    const cs = getComputedStyle(svg);
    const stroke = cs.stroke !== "none" ? cs.stroke : cs.color;
    const fg = over(toRgb(stroke), bgOf(svg));
    const got = ratio(fg, bgOf(svg));
    if (got < 3) out.push({ text: "[icon]", got: +got.toFixed(2), need: 3, cls: (svg.getAttribute("class")||"").slice(0,90), tag: "svg", parent: (svg.parentElement?.getAttribute("aria-label")||svg.parentElement?.tagName) });
  }
  // Placeholder text is text (WCAG 1.4.3): measure it from the ::placeholder pseudo-element.
  for (const input of document.querySelectorAll("input[placeholder],textarea[placeholder]")) {
    if (input.disabled) continue;
    const r = input.getBoundingClientRect(); if (r.width === 0) continue;
    const bg = bgOf(input);
    const fg = over(toRgb(getComputedStyle(input, "::placeholder").color), bg);
    const got = ratio(fg, bg);
    if (got < 4.5) out.push({ text: "[placeholder] " + input.getAttribute("placeholder").slice(0, 24), got: +got.toFixed(2), need: 4.5, cls: (input.className||"").toString().slice(0,90), tag: input.tagName.toLowerCase() });
  }
  return out;
};


const THEME_KEY = "starfish.theme";   // web/src/theme/ThemeProvider.tsx

async function signIn(page, email, landing) {
  await page.goto(base + "/signin");   // "/" would now open a guest session (#12)
  await page.locator("#email, input[type=email]").first().fill(email);
  await page.locator("#password").fill("starfish");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(landing, { timeout: 20000 });
}

const newPage = async (browser, theme) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, colorScheme: theme });
  const page = await ctx.newPage();
  await page.addInitScript(([key, t]) => { try { localStorage.setItem(key, t); } catch { /* private mode */ } }, [THEME_KEY, theme]);
  return { ctx, page };
};

const browser = await chromium.launch(launchOptions);
const results = {};
try {
  for (const theme of ["light", "dark"]) {
    const { ctx, page } = await newPage(browser, theme);
    await page.goto(base + "/signin");
    await page.waitForTimeout(800);
    results[`${theme} /signin`] = await page.evaluate(AUDIT);

    await signIn(page, "admin@starfish.local", /incidents/);
    await page.waitForSelector("tbody tr", { timeout: 15000 });
    results[`${theme} /incidents`] = await page.evaluate(AUDIT);

    // Expand every row so the detail panels are audited, then filter to an empty list.
    for (const b of await page.locator("[aria-expanded=false]").all()) await b.click().catch(() => {});
    await page.waitForTimeout(500);
    results[`${theme} /incidents (rows expanded)`] = await page.evaluate(AUDIT);
    await page.getByPlaceholder(/filter by function/i).first().fill("zzzz-no-such-function");
    await page.waitForTimeout(500);
    results[`${theme} /incidents (empty state)`] = await page.evaluate(AUDIT);

    await page.goto(base + "/settings");
    await page.getByText("Runtime settings").waitFor();
    results[`${theme} /settings`] = await page.evaluate(AUDIT);

    await page.goto(base + "/nope");
    await page.waitForTimeout(500);
    results[`${theme} /404`] = await page.evaluate(AUDIT);
    await ctx.close();

    // A signed-in user with no role lands on access-denied (own context: no shared session).
    const other = await newPage(browser, theme);
    await signIn(other.page, "nobody@starfish.local", /access-denied/);
    await other.page.waitForTimeout(800);
    results[`${theme} /access-denied`] = await other.page.evaluate(AUDIT);
    await other.ctx.close();

    // A brand-new visitor is a guest (#12): no sign-in, view-only Incidents and Settings.
    const guest = await newPage(browser, theme);
    await guest.page.goto(base + "/");
    await guest.page.waitForSelector("tbody tr", { timeout: 20000 });
    results[`${theme} /incidents (guest)`] = await guest.page.evaluate(AUDIT);
    await guest.page.goto(base + "/settings");
    await guest.page.getByText("Runtime settings").first().waitFor();
    results[`${theme} /settings (guest)`] = await guest.page.evaluate(AUDIT);
    await guest.ctx.close();
  }
} finally {
  await browser.close();
}

let total = 0;
for (const [screen, failures] of Object.entries(results)) {
  total += failures.length;
  console.log(`${failures.length === 0 ? "ok  " : "FAIL"} ${screen}: ${failures.length} failing`);
  const unique = new Map();
  for (const f of failures) unique.set(`${f.tag}|${f.cls}|${f.need}`, f);
  for (const f of unique.values()) {
    console.log(`       ${String(f.got).padStart(5)}:1 (need ${f.need}) <${f.tag}> "${f.text}"  class="${f.cls}"${f.parent ? ` parent=${f.parent}` : ""}`);
  }
}
console.log(`\n${total === 0 ? "No" : total} failing element${total === 1 ? "" : "s"} across ${Object.keys(results).length} screens.`);
process.exit(total === 0 ? 0 : 1);
