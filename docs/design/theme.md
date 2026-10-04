# Theme and colour rules

What the operator UI's colours mean, and which pairings are allowed. The values live in
`web/src/styles/theme.css`; this file is the reasoning, so a new screen picks colours the
same way. Everything here is checked: `web/src/lib/contrast.test.ts` guards the pairs
written into the source, and `pnpm audit:contrast` measures the rendered screens (below).

The standard is **WCAG 2.1 AA**: 4.5:1 for text, 3:1 for large text (24px, or 18.66px
bold) and for icons and other UI components. Disabled controls and the logo mark are exempt.

## What the status colours mean

| Colour | Means | Used for |
|---|---|---|
| `error` (red) | needs action | `new` incidents, failures |
| `warning` (amber) | needs attention | `acknowledged` |
| `info` (blue) | in flight | `logged` (tracked in an issue), links |
| `success` (green) | done | `resolved`, an open PR that is progressing |
| orange | a regression | `recurred`: needs action like `new`, and must not read as one |
| `gray` | inactive | `ignored`, secondary text |

The mapping for incident statuses is `STATUS_STYLES` in `web/src/pages/Incidents.tsx`.

## The brand scale

`brand-500` (`#f25c2f`) is the logo orange. It is **not a text background**: white on it is
3.31:1. Use it for the logo and for accents that carry no text.

| Use | Light mode | Ratio |
|---|---|---|
| Filled surface with white text (primary button, active nav item, active filter pill) | `bg-brand-700`, hover `bg-brand-800` | 5.99, 8.16 |
| A brand-coloured link on the page | `text-brand-700` | 5.99 on white |
| Brand tint with brand text (the `brand` badge) | `bg-brand-50 text-brand-700` | 5.54 |

White on `brand-600` is 4.30:1, which also fails. Disabled primary buttons are exempt.

## Text greys

Which grey is allowed depends on what is behind it. The page background is `gray-100`
(`StarfishLayout`), and cards are white.

| Text | On white (cards) | On the page background (`gray-100`) |
|---|---|---|
| `gray-500` | 4.83 ✓ | **4.40 ✗** |
| `gray-600` | 7.7 ✓ | 7.03 ✓ |
| `gray-400` | 2.56 ✗ | ✗ |

So: **secondary text sitting directly on the page needs `gray-600`; inside a white card
`gray-500` is enough; `gray-400` is for dark mode and the dark sidebar only** (there it is
6.9:1 on `gray-900`). The same goes for loading placeholders and empty states, which can
appear on either. Placeholder text is text: `placeholder:text-gray-500` in light mode.

## Info blue

| Use | Light mode | Ratio |
|---|---|---|
| A link | `text-info-800` | 6.6 on white |
| The `info` badge | `bg-info-50 text-info-800` | 6.2 |
| The `logged` pill | `bg-info-100 text-info-800` | 5.73 |

`info-700` is 4.75 on white but only 4.47 on `info-50` and 4.12 on `info-100`, so it is not
used for badges; `info-600` is 3.47 on white and is not used for text at all.

## Icons and icon buttons

Icons are UI components and need 3:1. An icon button that is `gray-400` on white is 2.56:1.
Use `text-gray-500 dark:text-gray-400`, and give the hover state a dark-mode colour too
(`dark:hover:text-gray-200`), or a hover that sets only a light-mode text colour renders
`gray-600` on `gray-700` in dark mode (1.35:1).

## Checking a change

```bash
pnpm -C web test                 # includes contrast.test.ts: the pairs written into the source
pnpm dev:emulated                # one terminal: seeded emulators + the UI on :5177
CHROMIUM_PATH=/path/to/chromium pnpm audit:contrast   # another: audits the rendered screens
```

`pnpm audit:contrast` signs in as the seeded admin and no-role users, opens a fresh browser as a guest, and, in light and dark,
measures every text element (against its real, composited background), every placeholder and
every icon on the sign-in, incidents (listed, rows expanded, empty), settings, 404,
access-denied and guest (incidents, settings) screens: 18 in all. It exits 1 on any failure. It needs a browser and the emulators, so
CI does not run it; `contrast.test.ts` is the always-on part.

It does not cover hover or focus states, or screens it cannot reach with the seeded data (an
error state, a loading flash). New screens should be added to the script.
