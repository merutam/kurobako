// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { element, numberFormatter, request } from "../../lib/common.js";
import { h } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";

/**
 * `initial` is the queue the page came with ({ items, revision }), when the
 * server could read it (a plain namespace): it is shown at once, and fetched
 * again only if it changed before the live connection was up.
 */
export const createLive = ({ status, renderItems, isItemsShown, onReady, onError, initial }) => {
  const refreshButton = element("#refresh");
  const liveStatus = element("#live-status");
  const viewersLabel = element("#viewers");
  let mode = null;
  let config = null;
  let queue = initial?.items ?? [];
  let revision = -1;
  /** The revision `queue` had when the page was made, until the first live connection. */
  let pageRevision = initial?.revision ?? null;
  let pending = [];
  let rendering = Promise.resolve();
  const serialize = (work) => {
    rendering = rendering.then(work).catch((error) => status.error(error.message));
    return rendering;
  };
  /**
   * After a mutation, live deltas update every open page; only without a live
   * connection is the queue fetched again.
   */
  const isLive = () => socket?.readyState === WebSocket.OPEN;
  const refreshUnlessLive = () => (isLive() ? Promise.resolve() : loadItems());

  /** The queue as of `nextRevision`, then the changes that came meanwhile, in order. */
  const settle = async (items, nextRevision) => {
    if (nextRevision < revision) return;
    queue = items;
    revision = nextRevision;
    await renderItems(queue);
    onReady?.();
    const buffered = pending;
    pending = [];
    for (const change of buffered) await applyChange(change);
  };

  const loadItems = async () => {
    refreshButton.disabled = true;
    try {
      const response = await request(`${mode.basePath}/ls?summary`, {
        cache: "no-store",
      });
      const items = await response.json();
      const nextRevision = Number(response.headers.get("X-Queue-Revision") ?? 0);
      await serialize(() => settle(items, nextRevision));
    } catch (error) {
      status.error(`Could not refresh: ${error.message}`);
      if (!isItemsShown()) onError?.(`Could not load namespace: ${error.message}`);
    } finally {
      refreshButton.disabled = false;
    }
  };

  const applyChange = async (change) => {
    if (change.revision <= revision) return;
    if (change.revision !== revision + 1) {
      void loadItems();
      return;
    }
    const byId = new Map(queue.map((item) => [item.id, item]));
    for (const id of change.removed) byId.delete(id);
    for (const item of change.upserts) byId.set(item.id, item);
    if (change.order.some((id) => !byId.has(id))) {
      void loadItems();
      return;
    }
    queue = change.order.map((id) => byId.get(id));
    revision = change.revision;
    await renderItems(queue);
  };

  // The server sends a ready marker and then queue deltas over
  // a WebSocket that the namespace keeps open while it sleeps. Pings stop
  // proxies from closing an idle connection (they are answered without waking
  // the server); a dropped connection is retried with a growing delay. A tab
  // hidden for a while closes its connection, since every connection and ping
  // costs requests, and reconnects with a fresh /ls when shown.
  const RECONNECT_FIRST_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_FIRST_MS;
  let hiddenTimer = null;
  let pausedWhileHidden = false;

  /** Others with the namespace open: shown only when there is someone besides this page. */
  const showViewers = (count) => {
    if (count <= 1) {
      viewersLabel.replaceChildren();
      return;
    }
    viewersLabel.replaceChildren(
      "· ",
      icon("eye", 14),
      ` ${numberFormatter.format(count)}`,
      h("span", { class: "visually-hidden" }, " connected"),
    );
  };

  const setLive = (live) => {
    liveStatus.textContent = live ? "· live" : pausedWhileHidden ? "· paused" : "· offline";
    if (!live) showViewers(0);
    liveStatus.classList.toggle("offline", !live && !pausedWhileHidden);
  };

  const connectLive = () => {
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    pausedWhileHidden = false;
    socket?.close();
    revision = -1;
    pending = [];

    const url = new URL(`${mode.basePath}/live`, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;

    current.addEventListener("open", () => {
      setLive(true);
      reconnectDelay = RECONNECT_FIRST_MS;
      pingTimer = setInterval(() => {
        if (current.readyState === WebSocket.OPEN) current.send(config.live.ping);
      }, config.live.pingSeconds * 1000);
    });
    current.addEventListener("message", (event) => {
      if (event.data === config.live.pong) return;
      const message = JSON.parse(event.data);
      if (message.type === "ready") {
        // The page's queue is still current: nothing to fetch.
        const unchanged = message.revision === pageRevision;
        pageRevision = null;
        if (unchanged) void serialize(() => settle(queue, message.revision));
        else void loadItems();
      }
      if (message.type === "change") {
        if (revision < 0) pending.push(message);
        else void serialize(() => applyChange(message));
      }
      if (message.type === "viewers") showViewers(message.count);
    });
    current.addEventListener("close", () => {
      if (socket !== current) return;
      clearInterval(pingTimer);
      setLive(false);
      // A failed connection still loads the queue. A later reconnect reconciles.
      if (!isItemsShown()) void loadItems();
      // Hidden tabs reconnect when they come back instead.
      if (document.visibilityState !== "visible") return;
      reconnectTimer = setTimeout(connectLive, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(() => {
        pausedWhileHidden = true;
        socket?.close(1000, "Tab hidden");
      }, config.live.hiddenCloseSeconds * 1000);
      return;
    }
    clearTimeout(hiddenTimer);
    // Closed (or still closing) while hidden or after a drop: start over.
    if (!socket || socket.readyState >= WebSocket.CLOSING) connectLive();
  });

  refreshButton.addEventListener("click", loadItems);

  return {
    /** Shows the page's own queue, before any connection. */
    showInitial: () => (initial ? renderItems(initial.items) : Promise.resolve()),
    setMode(value) {
      mode = value;
    },
    setConfig(value) {
      config = value;
    },
    connectLive,
    loadItems,
    refreshUnlessLive,
  };
};
