// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { iconTree } from "../../client/shared/icons.js";
import { h } from "./html";

export const Icon = ({ name, size }: { name: string; size?: number }) => iconTree(h, name, size);

/**
 * The identity sheet's mark: a box open at the top, turned 45°, Koma peeking
 * over its edge and the amber cursor on the right face; drawn heavy, as the
 * sheet does at small sizes. Native Hono JSX, the faces filled from the theme.
 */
export const KurobakoMark = () => (
  <svg class="site-logo" viewBox="0 0 120 120" width="32" height="32" aria-hidden="true">
    <g transform="translate(0 -4)" stroke="currentColor" stroke-width="7" stroke-linejoin="round">
      <path d="M60 62L26 45L60 28L94 45Z" style="fill: color-mix(in srgb, currentColor 14%, var(--bg))" />
      <path
        transform="translate(42 12) scale(.6)"
        stroke="none"
        fill="currentColor"
        fill-rule="evenodd"
        d="M10 96Q4 96 4 90L4 12Q4 4 10 8L28 22Q30 23.5 32 22L50 8Q56 4 56 12L56 90Q56 96 50 96Z M15 41a3 3 0 0 1 6 0v12a3 3 0 0 1-6 0Z M39 41a3 3 0 0 1 6 0v12a3 3 0 0 1-6 0Z"
      />
      <path d="M26 45L60 62V110L26 93Z" style="fill: var(--bg)" />
      <path d="M60 62L94 45V93L60 110Z" style="fill: color-mix(in srgb, currentColor 7%, var(--bg))" />
      <path d="M69 89.5L83 82.5" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" />
    </g>
  </svg>
);
