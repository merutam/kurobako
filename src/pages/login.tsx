// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Icon } from "./components/icons";
import { Page, type SiteView } from "./components/layout";

/**
 * A private instance's login, /k/login: a plain form, no script. The server
 * sends a right key on to `next` (where the visitor was going), and a wrong
 * one back here with `error`.
 */
export const renderLoginPage = (site: SiteView, { next = "/", error = "" } = {}) =>
  Page({
    site,
    title: "Log in · Kurobako",
    scripts: [],
    noIndex: true,
    children: (
      <>
        <h1>Private</h1>
        <p class="intro">This Kurobako is private. Log in with its key.</p>
        <p id="status" class={error ? "status error" : "status"} role="status" aria-live="polite">
          {error}
        </p>
        <form id="login-form" class="login-form" method="post" action={`${site.basePath}/k/login`}>
          <fieldset>
            <legend>Log in</legend>
            <input type="hidden" name="next" value={next} />
            <label for="key">Key</label>
            <input id="key" name="key" type="password" autocomplete="current-password" required />
            <p class="actions">
              <button data-icon="login" type="submit" class="primary">
                <Icon name="login" />
                Log in
              </button>
            </p>
          </fieldset>
        </form>
      </>
    ),
  });
