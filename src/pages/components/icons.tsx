// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { iconTree } from "../../client/shared/icons.js";
import { h } from "./html";

/**
 * One of the site's icons (src/client/shared/icons.js), drawn by the server: a control
 * with data-icon starts with it, so the browser has nothing to add.
 */
export const Icon = ({ name, size }: { name: string; size?: number }) => iconTree(h, name, size);
