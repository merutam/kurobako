// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/**
 * A file field: a hidden file input and its drop zone, and for several files
 * the list of those picked. <k-file-field> (public/components.js) gives it its
 * behavior in the browser: drops, and showing what was picked.
 */
export const FileField = ({
  id,
  zoneId,
  name,
  labelledBy,
  describedBy,
  accept,
  multiple = false,
  placeholder,
}: {
  id: string;
  zoneId: string;
  name?: string;
  labelledBy: string;
  describedBy: string;
  accept?: string;
  multiple?: boolean;
  placeholder: string;
}) => (
  <k-file-field>
    <input
      id={id}
      class="visually-hidden"
      name={name}
      type="file"
      multiple={multiple}
      accept={accept}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      required
    />
    <label id={zoneId} class="dropzone" for={id}>
      {placeholder}
    </label>
    {multiple ? <ul class="file-selection" aria-live="polite" hidden /> : null}
  </k-file-field>
);
