// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import {
  element,
  formatBytes,
  formatDuration,
  iconLink,
  ignoreStrayDrops,
  numberFormatter,
  request,
  restoreForm,
  SITE,
  storage,
} from "../lib/common.js";
import { createStatus } from "../lib/status.js";
// The admin dashboard: storage and activity numbers, the namespace list, a
// link to the request logs where the platform keeps them, and backups of the
// whole instance.
import { h } from "../shared/dom.js";
import { icon } from "../shared/icons.js";

const status = createStatus(element("#status"));
const summary = element("#summary");
const dashboard = element("#dashboard");
const refreshInterval = element("#refresh-interval");
const refreshButton = element("#refresh");
const systemStats = element("#system-stats");
const logsLink = element("#logs-link");
const logsSection = element("#logs");
const namespacesBody = element("#namespaces");
const namespacesPagination = element("#namespaces-pagination");
const namespaceSearch = element("#namespace-search");
const serverSelect = element("#server");
const backupZip = element("#backup-zip");
const backupTar = element("#backup-tar");
const serverLabel = element('label[for="server"]');

const INTERVAL_STORAGE_KEY = "kurobako-admin-refresh";
const row = (...cells) => h("tr", {}, ...cells.map((cell) => h("td", {}, cell)));
const statRow = (label, value) => h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, value));

/** The session is gone: the page, loaded again, is the login. */
class Unauthorized extends Error {
  constructor() {
    super("Log in again.");
  }
}

/**
 * Behind a router for several servers, the dashboard shows one at a time,
 * kept in the page's ?server=; the router says how many there are.
 */
let server = new URLSearchParams(location.search).get("server") ?? "";
let servers = 0;

/** An admin URL, for the server the dashboard is looking at. */
const adminUrl = (path) => {
  const url = new URL(`${SITE}/k/a/${path}`, location.origin);
  if (server) url.searchParams.set("server", server);
  return url;
};

/** An admin request; its JSON answer, or Unauthorized once the session is gone. */
const api = async (path, options) => {
  let response;
  try {
    response = await request(adminUrl(path), { cache: "no-store", ...options });
  } catch (error) {
    throw error.status === 401 ? new Unauthorized() : error;
  }
  const count = Number(response.headers.get("X-Kurobako-Servers"));
  if (count > 1) {
    servers = count;
    server = response.headers.get("X-Kurobako-Server") ?? server;
  }
  return response.json();
};

const renderServers = () => {
  serverSelect.hidden = serverLabel.hidden = servers < 2;
  if (servers < 2 || serverSelect.options.length === servers) {
    serverSelect.value = server;
    return;
  }
  serverSelect.replaceChildren(
    ...Array.from({ length: servers }, (_, index) =>
      h("option", { value: String(index + 1) }, `Server ${index + 1}`),
    ),
  );
  serverSelect.value = server;
};

const ago = (time) => `${formatDuration(Math.max(0, (Date.now() - Date.parse(time)) / 1000))} ago`;

const renderOverview = (overview) => {
  const where = servers > 1 ? ` · server ${server} of ${servers}` : "";
  summary.textContent = `${overview.version} · ${overview.deployedAt ? `deployed ${ago(overview.deployedAt)}` : "local"}${where}`;
  // A logs page to open, or else where to read them (a self-hosted server
  // writes them to standard output).
  logsSection.hidden = !overview.logsUrl && !overview.logsHint;
  logsLink.replaceChildren(
    ...(overview.logsUrl
      ? [
          // Another site (the host's dashboard): a link, in a new tab.
          h(
            "a",
            { class: "external-link", href: overview.logsUrl, target: "_blank", rel: "noopener" },
            "Open logs",
            icon("external", 14),
          ),
          ` on ${new URL(overview.logsUrl).hostname}`,
        ]
      : [overview.logsHint ?? ""]),
  );

  const sent = (counts) => counts.sentText + counts.sentFile + counts.sentEncrypted;
  systemStats.replaceChildren(
    statRow("Version ID", h("code", {}, overview.versionId || "—")),
    statRow(
      "Stored",
      overview.maxStorageBytes
        ? `${formatBytes(overview.storedBytes)} of ${formatBytes(overview.maxStorageBytes)}`
        : formatBytes(overview.storedBytes),
    ),
    statRow("Live connections", numberFormatter.format(overview.liveConnections)),
    statRow("Namespaces", numberFormatter.format(overview.namespaces.count)),
    statRow(
      "Sent today / 7 days",
      `${sent(overview.activityToday)} / ${sent(overview.activityLast7Days)}`,
    ),
    statRow("Opened once, 7 days", numberFormatter.format(overview.activityLast7Days.openedOnce)),
    statRow(
      "Encrypted namespaces",
      `${overview.encryptedNamespaces.count} (${overview.encryptedNamespaces.items} items)`,
    ),
  );
};

const renderNamespaces = (namespaces) => {
  namespacesBody.replaceChildren(
    ...(namespaces.length
      ? namespaces.map(({ name, items }) =>
          row(
            h("code", {}, `/${name}`),
            numberFormatter.format(items),
            h(
              "span",
              { class: "links" },
              h("a", { href: `${SITE}/${encodeURIComponent(name)}` }, "Open"),
              " · ",
              iconLink(`${SITE}/${encodeURIComponent(name)}/log`, "Access log", "users"),
            ),
          ),
        )
      : [h("tr", {}, h("td", { colspan: 3, class: "empty" }, "No namespaces."))]),
  );
};

/** The list is paged on the server; the page size comes back with each page. */
let offset = 0;
const renderPager = (page) => {
  if (page.total <= page.limit && page.offset === 0) {
    namespacesPagination.replaceChildren();
    return;
  }
  const last = Math.min(page.offset + page.items.length, page.total);
  const go = (next) => {
    offset = Math.max(0, next);
    void load();
  };
  const back = h("button", { type: "button", disabled: page.offset === 0 }, "← Previous");
  back.addEventListener("click", () => go(page.offset - page.limit));
  const forward = h("button", { type: "button", disabled: last >= page.total }, "Next →");
  forward.addEventListener("click", () => go(page.offset + page.limit));
  namespacesPagination.replaceChildren(
    back,
    h(
      "span",
      {},
      `${numberFormatter.format(page.total ? page.offset + 1 : 0)}–${numberFormatter.format(last)} of ${numberFormatter.format(page.total)}`,
    ),
    forward,
  );
};

const show = (overview, namespaces) => {
  renderServers();
  renderOverview(overview);
  renderNamespaces(namespaces.items);
  renderPager(namespaces);
};

let loading = false;
const load = async () => {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  try {
    const query = new URLSearchParams({ offset: String(offset) });
    if (namespaceSearch.value.trim()) query.set("q", namespaceSearch.value.trim());
    const [overview, namespaces] = await Promise.all([api("overview"), api(`namespaces?${query}`)]);
    show(overview, namespaces);
    if (status.isError()) status.clear();
  } catch (error) {
    if (error instanceof Unauthorized) location.reload();
    else status.error(`Could not refresh: ${error.message}`);
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
};

let timer = null;
const schedule = () => {
  clearInterval(timer);
  const seconds = Number(refreshInterval.value);
  storage.set(INTERVAL_STORAGE_KEY, refreshInterval.value);
  if (seconds > 0) {
    timer = setInterval(() => {
      if (document.visibilityState === "visible" && !dashboard.hidden) void load();
    }, seconds * 1000);
  }
};

refreshButton.addEventListener("click", load);

ignoreStrayDrops();
backupZip.addEventListener("click", () => location.assign(adminUrl("zip")));
backupTar.addEventListener("click", () => location.assign(adminUrl("tar")));
restoreForm({
  form: element("#restore-form"),
  input: element("#restore-file"),
  status,
  send: (file) => api("import", { method: "POST", body: file }),
  done: load,
});
serverSelect.addEventListener("change", () => {
  server = serverSelect.value;
  const url = new URL(location.href);
  url.searchParams.set("server", server);
  history.replaceState(null, "", url);
  offset = 0;
  void load();
});
refreshInterval.addEventListener("change", schedule);
// A new filter starts again from the first page.
let searchTimer = null;
namespaceSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    offset = 0;
    void load();
  }, 300);
});

const savedInterval = storage.get(INTERVAL_STORAGE_KEY);
if ([...refreshInterval.options].some((option) => option.value === savedInterval)) {
  refreshInterval.value = savedInterval;
}
schedule();
// The page comes with the first answers (it loads this script only when logged in).
const { overview, namespaces } = JSON.parse(element("#admin-data").textContent);
show(overview, namespaces);
