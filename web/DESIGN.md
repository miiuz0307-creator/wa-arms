# BotiX design system (web)

Hebrew, RTL, used by taxi-station owners on phones (often at night) and on desktop.

## Look
- Neutrals: cool "asphalt" greys (Tailwind `slate-*`, re-pointed in `app/globals.css`).
- Action colour: "dispatch blue" (`indigo-*`, re-pointed). Primary button = `Button` (solid blue).
- Signature accent: taxi amber `#FFC21A` – ONLY for the brand mark, the active-nav indicator and the
  station roof-sign (`.roof-sign`). Never for body text or random highlights.
- Status: green = works (`emerald`), red = broken (`rose`), amber = attention (`amber`). Always pair colour with words.
- Surfaces: page `var(--bg)`, cards `Card` (white, hairline border, almost no shadow), radius 16 for cards, 12 for controls.
- Font: IBM Plex Sans Hebrew. Numbers use `tabular-nums`.
- Dark mode is automatic: write light-mode classes with the slate / indigo / emerald / rose / amber / sky scales and
  `bg-white`; globals.css inverts them under `.dark`. Do NOT hard-code hex colours for text/backgrounds in pages
  (exception: the asphalt sidebar). Avoid `bg-slate-900 text-white` (inverts in dark) – use `bg-[#151920] text-white`.
- No gradients as decoration, no rainbow, no emoji in UI chrome, no ALL CAPS, no "→" in buttons.
- Motion: only `animate-rise` on things that open (modals, sheets, toasts).

## Components (`@/components/ui`)
`Card`, `Section` (card with title row + action), `PageHeader`, `Button` (variant primary/secondary/ghost/danger/success,
size sm/md/lg, `loading`), `Badge` (tone, dot), `Lamp` (status light), `Field`, `Input`, `Textarea`, `Select`, `Toggle`,
`Checkbox`, `Segmented` (pill tabs/filters), `Stat`, `Empty` (icon, title, text, action), `Skeleton`, `Spinner`
(page skeleton), `Progress`, `Modal`, `ask({title, text, ok, danger})` → Promise<boolean> (styled confirm; never use
`window.confirm`), `toast(text, 'ok'|'error')`.
`@/components/Brand`: `BrandMark`, `BrandWord`, `StationLogo`, `StationSign`, `useBrand(enabled)`, `refreshBrand()`, `ThemeToggle`.

## Writing
Plain Hebrew, sentence-style, active verbs. Buttons say exactly what happens ("שמירה", "שליחת אסמכתה", "אישור התשלום").
The toast repeats the same verb ("נשמר", "האסמכתה נשלחה"). Errors say what happened and what to do. Empty states invite
the next action. Never show numbers that are not real data.

## Layout
- Page = `PageHeader` + content, max width 6xl (Shell handles it). Mobile first: one column, cards full width,
  tap targets ≥ 40px, bottom sheet modals (Modal does this). Desktop: 2–3 column grids where useful.
- Lists: `divide-y divide-slate-100` rows inside a `Card`/`Section`, row padding `px-5 py-3.5`.
- Tables only on desktop (`hidden md:table`), with a stacked card list on mobile.

## Data
`sb()` from `@/lib/supabase` (supabase-js). Reads that can exceed 1000 rows must use `allRows` / `allGroups` from
`@/lib/allRows` or carry a `// rows: bounded – reason` comment (a test enforces this). Live refresh: `useRealtime(tables, load)`.
Roles: `useAuth()` → `can('viewer'|'operator'|'admin'|'owner')`, `isStation` (station-code login = manager),
`isSuper` (system owner), `station` ({id, name, is_home, status, sub_end, acting}).
