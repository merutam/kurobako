// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The admin dashboard: storage and activity numbers, the namespace list, and
// a link to the request logs where the platform keeps them.
import { element, formatBytes, formatDuration } from "/common.js";
import { createStatus } from "/status.js";

const status = createStatus(element("#status"));
const summary = element("#summary");
const loginForm = element("#login-form");
const keyInput = element("#key");
const dashboard = element("#dashboard");
const refreshInterval = element("#refresh-interval");
const refreshButton = element("#refresh");
const logoutButton = element("#logout");
const systemStats = element("#system-stats");
const logsLink = element("#logs-link");
const logsSection = element("#logs");
const namespacesBody = element("#namespaces");
const namespacesPager = element("#namespaces-pager");
const namespaceSearch = element("#namespace-search");
const serverSelect = element("#server");
const serverLabel = element('label[for="server"]');

const INTERVAL_STORAGE_KEY = "kurobako-admin-refresh";
const numberFormatter = new Intl.NumberFormat();

/** Builds an element: el("td", { className: "x" }, "text", child). */
const el = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
};
const row = (...cells) => el("tr", {}, ...cells.map((cell) => el("td", {}, cell)));
const statRow = (label, value) =>
  el("tr", {}, el("th", { scope: "row" }, label), el("td", {}, value));

class Unauthorized extends Error {}

/**
 * Behind a router for several servers, the dashboard shows one at a time,
 * kept in the page's ?server=; the router says how many there are.
 */
let server = new URLSearchParams(location.search).get("server") ?? "";
let servers = 0;

const api = async (path, options) => {
  const url = new URL(`/a/${path}`, location.origin);
  if (server) url.searchParams.set("server", server);
  const response = await fetch(url, { cache: "no-store", ...options });
  if (response.status === 401) throw new Unauthorized();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Server error (${response.status}).`);
  const count = Number(response.headers.get("X-Kurobako-Servers"));
  if (count > 1) {
    servers = count;
    server = response.headers.get("X-Kurobako-Server") ?? server;
  }
  return body;
};

const renderServers = () => {
  serverSelect.hidden = serverLabel.hidden = servers < 2;
  if (servers < 2 || serverSelect.options.length === servers) {
    serverSelect.value = server;
    return;
  }
  serverSelect.replaceChildren(
    ...Array.from({ length: servers }, (_, index) =>
      el("option", { value: String(index + 1) }, `Server ${index + 1}`),
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
      ? [el("a", { className: "button", href: overview.logsUrl }, "Open logs")]
      : [overview.logsHint ?? ""]),
  );

  const sent = (counts) => counts.sentText + counts.sentFile + counts.sentEncrypted;
  systemStats.replaceChildren(
    statRow("Version ID", el("code", {}, overview.versionId || "—")),
    statRow("Stored files", formatBytes(overview.storedBytes)),
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
            el("code", {}, `/${name}`),
            numberFormatter.format(items),
            el(
              "span",
              { className: "links" },
              el("a", { href: `/${encodeURIComponent(name)}` }, "Open"),
              " · ",
              el("a", { href: `/${encodeURIComponent(name)}/log` }, "Access log"),
            ),
          ),
        )
      : [el("tr", {}, el("td", { colSpan: 3, className: "empty" }, "No namespaces."))]),
  );
};

/** The list is paged on the server; the page size comes back with each page. */
let offset = 0;
const renderPager = (page) => {
  if (page.total <= page.limit && page.offset === 0) {
    namespacesPager.replaceChildren();
    return;
  }
  const last = Math.min(page.offset + page.items.length, page.total);
  const go = (next) => {
    offset = Math.max(0, next);
    void load();
  };
  const back = el("button", { type: "button", disabled: page.offset === 0 }, "← Previous");
  back.addEventListener("click", () => go(page.offset - page.limit));
  const forward = el("button", { type: "button", disabled: last >= page.total }, "Next →");
  forward.addEventListener("click", () => go(page.offset + page.limit));
  namespacesPager.replaceChildren(
    back,
    el(
      "span",
      {},
      `${numberFormatter.format(page.total ? page.offset + 1 : 0)}–${numberFormatter.format(last)} of ${numberFormatter.format(page.total)}`,
    ),
    forward,
  );
};

const showLogin = () => {
  dashboard.hidden = true;
  loginForm.hidden = false;
  summary.textContent = "Admin";
  keyInput.focus();
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
    loginForm.hidden = true;
    dashboard.hidden = false;
    renderServers();
    renderOverview(overview);
    renderNamespaces(namespaces.items);
    renderPager(namespaces);
    if (status.isError()) status.clear();
  } catch (error) {
    if (error instanceof Unauthorized) showLogin();
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
  try {
    localStorage.setItem(INTERVAL_STORAGE_KEY, refreshInterval.value);
  } catch {
    // The choice still applies to this page view.
  }
  if (seconds > 0) {
    timer = setInterval(() => {
      if (document.visibilityState === "visible" && !dashboard.hidden) void load();
    }, seconds * 1000);
  }
};

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: keyInput.value }),
    });
    keyInput.value = "";
    status.clear();
    await load();
  } catch (error) {
    status.error(error instanceof Unauthorized ? "Wrong key." : error.message);
  }
});

logoutButton.addEventListener("click", async () => {
  await api("logout", { method: "POST" }).catch(() => {});
  showLogin();
});
refreshButton.addEventListener("click", load);
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

try {
  const saved = localStorage.getItem(INTERVAL_STORAGE_KEY);
  if (saved !== null && [...refreshInterval.options].some((option) => option.value === saved)) {
    refreshInterval.value = saved;
  }
} catch {
  // Falls back to the default interval.
}
schedule();
await load();
