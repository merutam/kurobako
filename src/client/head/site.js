// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Every page's classic script, in <head>, as one request: the theme and a
// read-only link's look apply before the first paint; the rest waits for
// the page (each part says when).
import "./parts/theme.js";
import "./parts/read-link.js";
import "./parts/scroll-top.js";
import "./parts/service-worker.js";
