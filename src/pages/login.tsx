// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { Layout, type SiteView } from "./components/layout";

/** A plain form, no script, so it works everywhere. */
export const LoginPage = ({
  site,
  next = "/",
  error = "",
}: {
  site: SiteView;
  next?: string;
  error?: string;
}) => (
  <Layout site={site} title="Log in · Kurobako" scripts={[]} noIndex>
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
          <button type="submit" class="primary">
            Log in
          </button>
        </p>
      </fieldset>
    </form>
  </Layout>
);
