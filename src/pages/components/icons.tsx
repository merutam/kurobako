// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { iconTree } from "../../client/shared/icons.js";
import { h } from "./html";

export const Icon = ({ name, size }: { name: string; size?: number }) => iconTree(h, name, size);
