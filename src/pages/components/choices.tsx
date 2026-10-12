// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/** Plain text for the current choice, brackets for the others (docs/design.md). */
export const Choices = ({
  id,
  label,
  name,
  choices,
  current,
}: {
  id: string;
  label: string;
  /** For screen readers. */
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
