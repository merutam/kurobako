// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { el, element, numberFormatter, request } from "../common.js";
import { icon } from "../icons.js";

export const LIVE_FIRST_QUEUE_MS = 3_000;

export const createLive = ({ status, renderItems, isItemsShown }) => {
  const refreshButton = element("#refresh");
  const liveStatus = element("#live-status");
  const viewersLabel = element("#viewers");
  let mode = null;
  let config = null;
  /**
   * After a send, edit, delete or rename, the live connection brings the new queue to
   * every open page, this one included; only without it is the queue fetched.
   */
  const isLive = () => socket?.readyState === WebSocket.OPEN;
  const refreshUnlessLive = () => (isLive() ? Promise.resolve() : loadItems());
  /** How long the first queue may take over the live connection before it is fetched. */

  const loadItems = async () => {
    refreshButton.disabled = true;
    try {
      const response = await request(`${mode.basePath}/ls?summary`, {
        cache: "no-store",
      });
      await renderItems(await response.json());
    } catch (error) {
      status.error(`Could not refresh: ${error.message}`);
    } finally {
      refreshButton.disabled = false;
    }
  };

  // The server pushes the whole queue on connect and after every change, over
  // a WebSocket that the namespace keeps open while it sleeps. Pings stop
  // proxies from closing an idle connection (they are answered without waking
  // the server); a dropped connection is retried with a growing delay. A tab
  // hidden for a while closes its connection, since every connection and ping
  // costs requests, and reconnects (getting the whole queue) when shown.
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
      el("span", { className: "visually-hidden" }, " connected"),
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
      if (message.type === "items") {
        void renderItems(message.items);
      }
      if (message.type === "viewers") showViewers(message.count);
    });
    current.addEventListener("close", () => {
      if (socket !== current) return;
      clearInterval(pingTimer);
      setLive(false);
      // Never connected long enough to bring the queue: fetch it instead.
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
