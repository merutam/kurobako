// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { type AccessLogEntry, locationOf } from "../core/visits";
import { Layout, type SiteView } from "./components/layout";

const LogContent = ({
  title,
  backHref,
  jsonHref,
  entries,
}: {
  title: string;
  backHref: string | null;
  jsonHref: string;
  entries: AccessLogEntry[];
}) => (
  <>
    <p id={backHref ? undefined : "log-back-row"} hidden={backHref ? undefined : true}>
      <a id={backHref ? undefined : "log-back"} href={backHref ?? "#"}>
        Back to namespace
      </a>
    </p>
    <h1>
      Access log · <span id="log-title">{title}</span>
    </h1>
    <p class="intro">
      {entries.length} IP{entries.length === 1 ? "" : "s"} · <a href={jsonHref}>As JSON</a>
    </p>
    {entries.length ? (
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Last seen (UTC)</th>
              <th>Requests</th>
              <th>Last route</th>
              <th>User agent</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr>
                <td>
                  <code>{entry.ip}</code>
                  {locationOf(entry) ? <small>{locationOf(entry)}</small> : null}
                </td>
                <td>
                  <time datetime={entry.lastSeenAt}>{entry.lastSeenAt}</time>
                </td>
                <td>{entry.hits}</td>
                <td class="route">
                  <small>{entry.lastMethod}</small>
                  <code title={entry.lastPath}>{entry.lastPath}</code>
                </td>
                <td class="agent">
                  <span title={entry.userAgent}>{entry.userAgent || "—"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p class="empty">No entries.</p>
    )}
  </>
);

export const LogPage = ({
  site,
  title,
  backHref,
  jsonHref,
  entries,
}: {
  site: SiteView;
  title: string;
  /** The way back to the namespace; null for an encrypted one, which knows it once opened. */
  backHref: string | null;
  jsonHref: string;
  entries: AccessLogEntry[];
}) => (
  <Layout
    site={site}
    title={`${title} access log · Kurobako`}
    scripts={["log"]}
    // An encrypted namespace's log takes its name from the page's fragment
    // (see log.js): it shows once that is in place, as the namespace does.
    decrypting={backHref === null ? "Decrypting access log…" : undefined}
  >
    <LogContent title={title} backHref={backHref} jsonHref={jsonHref} entries={entries} />
  </Layout>
);
