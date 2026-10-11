// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

/**
 * A file field: the browser's own file input, shown as a drop zone. It takes
 * files dropped on it and says which were picked, with no script.
 */
export const FileField = ({
  id,
  name,
  labelledBy,
  describedBy,
  accept,
  multiple = false,
}: {
  id: string;
  name?: string;
  labelledBy: string;
  describedBy: string;
  accept?: string;
  multiple?: boolean;
}) => (
  <input
    id={id}
    class="file-drop"
    name={name}
    type="file"
    multiple={multiple}
    accept={accept}
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    required
  />
);
