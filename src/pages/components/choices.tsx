// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/**
 * A choice among a few options, as a line of words: "open: one [several]
 * [all]". The current one reads as plain text, the others as bracketed
 * actions (docs/design.md); choiceGroup (lib/common.js) keeps them so.
 * `choices` are [value, label]; `current` is the value shown chosen until
 * the page's script says otherwise.
 */
export const Choices = ({
  id,
  label,
  name,
  choices,
  current,
}: {
  id: string;
  /** The word before the options ("open"), shown. */
  label: string;
  /** What the group chooses, for screen readers ("Open items"). */
  name: string;
  choices: ReadonlyArray<readonly [string, string]>;
  current: string;
}) => (
  <fieldset id={id} class="choices">
    <legend class="visually-hidden">{name}</legend>
    <span class="choices-label" aria-hidden="true">
      {label}:
    </span>
    {choices.map(([value, text]) => (
      <button
        type="button"
        class="row-action"
        data-choice={value}
        aria-pressed={String(value === current)}
      >
        {text}
      </button>
    ))}
  </fieldset>
);
