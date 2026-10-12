# Design rules

Kurobako resembles a terminal: monospaced text, thin borders and a single
accent color. It follows the small web approach, comfortable contrast,
restrained type, and predictable layout.

The values (colors, sizes, spacing, radius) live in
[`src/client/styles/tokens.css`](../src/client/styles/tokens.css); this file is
what the code cannot say: how to decide when adding something.

## Before adding an element

1. Could it be just text and a 1 px border? Then make it that.
2. Does its state (active, selected, error) show through color or a character,
   with no extra effect?
3. Does it work on a phone and with the keyboard?

## Rules

- **One accent**, only on what is clickable or selected, and on heading
  prefixes. `ok` and `err` mark states, never decoration.
- **One typeface.** Hierarchy comes from size and weight. Headings carry their
  Markdown prefix (`#`, `##`) in the accent, hidden from screen readers.
- **Boxes** are a 1 px border, no shadow, and only for blocks with their own
  header. Lists are rows with dashed separators, never a card per item.
- **Buttons by weight:** one primary per screen for the main action; bordered
  secondary buttons for actions complete in themselves; bracketed words
  (`[edit]`, `[settings]`) for actions tied to a row or a field, so lists never
  become a wall of boxes.
- **Choices** read as a line of words, `open: one [several] [all]`: the current
  one as plain text, the others as bracketed actions.
- **Tabs** are muted words over a line; the chosen one in the text's color,
  its line in the accent.
- **Words, not icons.** Buttons in sentence case (`Copy link`); bracketed
  actions, choices and tabs in lowercase, as commands. The few icons (theme,
  resize) are stroke SVGs hidden from screen readers; never emoji.
- **Instant:** no animation, transition, spinner or skeleton.
- **A missing page** (a gone share link) says so under its heading, not only in
  a passing status line.

## Accessibility

- A visible focus outline in the accent on everything focusable.
- Clickable things at least 44 × 44 px.
- Body text at least 4.5:1 on the background, in both themes: check again when
  adding a tone.
- Real elements: `<button>`, `<a href>`, `<input>` with a `<label>`.
- Reading and navigation work without JavaScript.

## Avoid

Shadows, gradients, blur; a second typeface; a second accent; phosphor green,
scanlines, typed-out text or other terminal cosplay.
