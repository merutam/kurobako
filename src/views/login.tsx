// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Page, type SiteView } from "./layout";

/** A private instance's login, /k/login. */
export const renderLoginPage = (site: SiteView) =>
  Page({
    site,
    title: "Log in · Kurobako",
    scripts: [{ path: "/login.js", module: true }],
    noIndex: true,
    children: (
      <>
        <h1>Private</h1>
        <p class="intro">This Kurobako is private. Log in with its key.</p>
        <p id="status" class="status" role="status" aria-live="polite" />
        <form id="login-form" class="login-form">
          <fieldset>
            <legend>Log in</legend>
            <label for="key">Key</label>
            <input id="key" name="key" type="password" autocomplete="current-password" required />
            <p class="actions">
              <button data-icon="login" type="submit" class="primary">
                Log in
              </button>
            </p>
          </fieldset>
        </form>
      </>
    ),
  });
