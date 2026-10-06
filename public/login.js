// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The login of a private instance: the key opens a session, then the page
// that sent the visitor here.
import { element, request, SITE, setBusy } from "./common.js";
import { createStatus } from "./status.js";

const status = createStatus(element("#status"));
const form = element("#login-form");
const keyInput = element("#key");

/** Where to go next: a path inside this site, never another one. */
const next = () => {
  const path = new URLSearchParams(window.location.search).get("next") ?? "/";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.progress("Logging in…");
  setBusy(form, true);
  try {
    await request(`${SITE}/k/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: keyInput.value }),
    });
    window.location.replace(`${SITE}${next()}`);
  } catch (error) {
    status.error(error.message);
    setBusy(form, false);
    keyInput.select();
  }
});
