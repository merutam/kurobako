# Kurobako — Design guide

Oct 10, 2026

## Principle

Kurobako looks like a well-kept terminal: monospaced text, thin borders and a single accent color. The rule that holds it all together is that **interaction shows through color and brackets, never through shadow, gradient or rounding**.

The reference is the old personal web (the small web), but deliberate, not abandoned. It is not brutalist: contrast is comfortable, type is restrained and the layout is predictable.

Three questions decide any new element:

1. Could it be just text and a 1 px border? If so, make it that.
2. Does its state (active, selected, error) show through color or a character, with no extra visual effect?
3. Does it work on a phone and with the keyboard?

## Color

Two palettes share the same tokens; the dark theme is the default. The accent is the interface's only saturated color and marks everything clickable or selected.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `bg` | #121211 | #F4F1EA | Page background |
| `fg` | #E6E1D6 | #1A1915 | Main text |
| `dim` | #B9B3A6 | #4A463F | Secondary text, dates, descriptions |
| `muted` | #8C877C | #615C53 | Labels, prompts, counters |
| `border` | #3A3934 | #BDB6A8 | Borders of boxes and fields |
| `rule` | #2E2D29 | #D6D0C3 | Dashed separators between rows |
| `panel` | #1A1917 | #ECE8DE | Background of fields and code blocks |
| `chip` | #24231F | #E2DDD1 | Inline code, tags, field labels |
| `accent` | #E8B04F | #8A5200 | Links, the heading's #, selection, primary button |
| `accent-hover` | #F2C779 | #9A5C00 | The accent under the pointer |
| `on-accent` | #121211 | #FFFFFF | Text on the accent |
| `ok` | #8FC27A | #2F6B1F | Success state |
| `err` | #E7806C | #A3321F | Error state |

The accent changes tone between themes to keep its contrast: light amber disappears on a cream background. `ok` and `err` only mark states, never decoration.

## Type

One monospaced family for everything: JetBrains Mono, falling back to the system's monospace (`ui-monospace`, SF Mono, Menlo, Consolas, DejaVu Sans Mono, then `'Courier New'`). Hierarchy comes from size and weight, never from a second typeface.

| Role | Size | Weight | Detail |
| --- | --- | --- | --- |
| Page title (h1) | 32–48 px | 700 | `letter-spacing: -0.02em`, `line-height: 1.1` |
| Section (h2) | 22 px | 700 | ` ## ` prefix in `accent` |
| Body | 15 px | 400 | `line-height: 1.65`, at most 72ch wide |
| Lists and tables | 14 px | 400 | Dates and kinds in `dim` |
| Labels, prompts, metadata | 13 px | 400 | `muted` |

Headings carry their Markdown prefix (` # `, ` ## `) in the accent, hidden from screen readers so the symbol is not read out. File names and paths show as literal text: `notes.txt`, `project/`, `/about/`.

Inline code has a `chip` background and `padding: 1px 6px`, with no border and no rounding.

## Layout and spacing

One centered column up to 1120 px (`--col`), with a 20 px side margin on phones. There is no fixed sidebar; secondary content goes in a grid that stacks (`repeat(auto-fit, minmax(240px, 1fr))`).

- **Vertical rhythm:** 56 px between sections, 16 px within a section, 8–10 px between items of a group.
- **Boxes:** a 1 px `border` only, `border-radius: 0`, no shadow. Use a box only when the content is a block with its own header, such as a listing or a panel.
- **Box header:** a `muted` line with the "command" on the left (`$ ls -lt ~/notes`) and a counter on the right, above a bottom border.
- **Separators:** a 1 px dashed `rule` line between list rows; dashed `border` above the footer.
- **Wide tables:** inside a box with `overflow-x: auto`, so the page never scrolls sideways.

## Components

Every component follows the same recipe: inherited font, 1 px border, square corners and at least 44 px tall when clickable.

| Component | Look | Active or selected |
| --- | --- | --- |
| Header | The logo and the site's name on the left, the theme button on the right | — |
| Link | `accent`, underlined with `text-underline-offset: 3px` | Hover lightens the accent |
| Primary button | `accent` background, `on-accent` text, weight 700 | One per screen, for the main action |
| Secondary button | Transparent background, `border` border, `fg` text | Hover turns the border `accent` |
| Disabled button | Dashed border, `muted` text | A real `disabled` attribute |
| Bracketed action | `accent` text between `muted` `[` `]`, no border: `[copy]`, `[settings]` | Hover lightens the accent; an action that deletes turns `err` |
| Choice | A `muted` label, then the options: `open: one [several] [all]` | The chosen one as plain `fg` text, without brackets; the others are bracketed actions |
| Filter / clickable tag | Text in brackets: `[ note ]`, `border` border | `accent` background, `on-accent` text, `aria-pressed="true"` |
| Text field | `panel` background, `border` border, a prompt-style label above (`> name`) | Focus outlined in `accent` |
| Search | A `$ grep` label in a `chip` box against the field's left | Filters while typing; empty shows `grep: no results` |
| Checkbox | Native, with `accent-color` | — |
| Tabs | `muted` text, no border, a 2 px line below | `fg` text and an `accent` line |
| Item list | Rows with date, kind and name; the name is the link | Dashed `rule` separator |
| State badge | Text with a border of its own color: `ok`, `pending`, `error` | `ok` in `ok`, `pending` in `accent`, `error` in `err` |
| Progress | ASCII: `[############--------] 60%` | Filled part in `accent`, the rest in `muted` |
| Pagination | `«` `1` `2` `3` `»` in 44 × 44 px boxes | Current page on an `accent` background |
| Collapsible | Native `<details>` and `<summary>`, no JavaScript | Open shows its content in `dim` |
| Status message | An output-style line: `> ok: message sent` | Uses `role="status"` |
| Footer | A dashed line, then the version and links in `muted` | — |

**Which button.** Visual weight follows the action's importance:

1. **Primary**: the screen's main action, only one (Send, Open, Log in, Restore).
2. **Secondary**: actions complete in themselves, worth a large touch target (Random name, Copy link, Create shared view, Save zip).
3. **Bracketed**: actions tied to a piece of content or repeated per row (`[edit]`, `[remove]`), and helper controls of a heading or field (`[media]`, `[settings]`, `[preview]`). Bordered buttons on every row of a list would make a wall of boxes.

Buttons are written in sentence case (`Copy link`, `Open once`); bracketed actions, choices and tabs in lowercase, as commands (`[copy]`, `open: one`, `files`). A missing page (a gone share link or view) says so in its text, under its heading, never only in a passing status line.

## Interaction and accessibility

Every state change is instant: no animation, no transition, no fake loading.

- **Focus:** `outline: 2px solid var(--accent)` with `outline-offset: 2px` on everything focusable. Never remove the outline without putting another in its place.
- **Touch targets:** buttons, filters and pages at least 44 × 44 px.
- **Contrast:** body text at least 4.5:1 on `bg`. The tokens above meet this in both themes; check again when adding a new tone.
- **Real elements:** `<button>`, `<a href>`, `<input>` with `<label>`. Never `onclick` on a `<div>` or `<span>`.
- **Decorative symbols:** the `#`, the brackets and the cursor are hidden from screen readers; icon-only buttons carry an `aria-label`.
- **Theme:** follows `prefers-color-scheme` by default; the button cycles auto, light and dark and remembers the choice. Its icons (half circle, sun, moon) are stroke SVGs, never emoji.
- **Without JavaScript:** navigation, links, collapsibles and reading work without script. Script comes in only for search, filters, tabs and the theme.

## What to avoid

Each item below drags the look toward "a modern app in disguise" or "terminal cosplay".

- Shadows, gradients, blur and rounded corners.
- Cards with their own background for each list item; use rows with separators.
- A second typeface, headings included.
- More than one accent color, or the accent on something that is neither interactive nor a heading.
- Emoji in the interface.
- Phosphor green on black, scanlines, CRT effects and text typed out letter by letter.
- Icons as the only way to tell an action; prefer text in brackets.
- Entrance animations, spinners and loading skeletons.

## Starting CSS tokens

Paste this at the top of the stylesheet; the rest of the site should use only these variables. The site's own are in `src/client/styles/tokens.css`.

```css
:root {
  --font: 'JetBrains Mono', ui-monospace, 'Courier New', monospace;
  --bg: #121211;  --fg: #E6E1D6;  --dim: #B9B3A6;  --muted: #8C877C;
  --border: #3A3934;  --rule: #2E2D29;  --panel: #1A1917;  --chip: #24231F;
  --accent: #E8B04F;  --on-accent: #121211;  --ok: #8FC27A;  --err: #E7806C;
  --col: 1120px;  --gap-section: 56px;  --gap: 16px;  --hit: 44px;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #F4F1EA;  --fg: #1A1915;  --dim: #4A463F;  --muted: #615C53;
    --border: #BDB6A8;  --rule: #D6D0C3;  --panel: #ECE8DE;  --chip: #E2DDD1;
    --accent: #8A5200;  --on-accent: #FFFFFF;  --ok: #2F6B1F;  --err: #A3321F;
  }
}

:root[data-theme="light"] {
  --bg: #F4F1EA;  --fg: #1A1915;  --dim: #4A463F;  --muted: #615C53;
  --border: #BDB6A8;  --rule: #D6D0C3;  --panel: #ECE8DE;  --chip: #E2DDD1;
  --accent: #8A5200;  --on-accent: #FFFFFF;  --ok: #2F6B1F;  --err: #A3321F;
}

body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.65 var(--font);
}
a { color: var(--accent); text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
* { border-radius: 0; box-shadow: none; }
```
