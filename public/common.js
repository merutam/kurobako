// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// What every page's script shares: finding and building elements, talking to
// the server, formatting numbers, sizes and times, the clipboard, file fields
// and the restore of a backup. (theme.js, a classic script that runs before
// the page is drawn, keeps to itself.)

import { icon } from "./icons.js";

export const element = (selector) => {
  const found = document.querySelector(selector);
  if (!found) throw new Error("Something went wrong. Reload the page.");
  return found;
};

/**
 * The site's own path under its domain: "" at the root, or e.g. "/k". This
 * file is served at the site's root, so its own address tells.
 */
export const SITE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** Builds an element: el("td", { className: "x" }, "text", child). Null children are left out. */
export const el = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
};

/** Disables (or enables again) every control of a form while it is at work. */
export const setBusy = (form, busy) => {
  for (const control of form.elements) control.disabled = busy;
};

/**
 * localStorage, for preferences only: a browser that refuses it (private
 * windows, blocked storage) just forgets them.
 */
export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The choice still applies to this page view.
    }
  },
};

/** The public config the server embeds in each page (no request needed). */
export const readConfig = () => JSON.parse(element("#config").textContent);

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
/** Counts as the visitor's language writes them (1,234). */
export const numberFormatter = new Intl.NumberFormat();

/** Decimal units, like the limits they show (100 MB, 64 kB). */
export const formatBytes = (bytes) => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
};

export const formatDuration = (seconds) => {
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? units.at(-1);
  const value = Math.round(seconds / size);
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};

/** How long ago, in a few characters: "now", "5 min", "3 h", "2 d". */
export const formatAge = (date) => {
  const minutes = Math.floor((Date.now() - Date.parse(date)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
};

export const formatExpiry = (expiresAt) => {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (remainingMs <= 0) return "expired";
  const units = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
  ];
  const match = units.find(([, size]) => remainingMs >= size);
  if (match)
    return `expires ${relativeFormatter.format(Math.floor(remainingMs / match[1]), match[0])}`;
  return `expires ${relativeFormatter.format(Math.ceil(remainingMs / 60_000), "minute")}`;
};

/** A failed request: the server's own message, and its status. */
export class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** fetch, failing with the server's {"error"} message (or its status). */
export const request = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new RequestError(body.error || `Server error (${response.status}).`, response.status);
  }
  return response;
};

export const compactText = (text) => text.replace(/\s+/g, " ").trim() || "(blank)";

/** Burn-after-reading texts never show a preview: that would be a read. */
export const HIDDEN_TITLE = "Hidden until opened";

/** A button; `iconName` (see icons.js) puts that icon before its label. */
export const button = (label, onClick, className, iconName) => {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  if (iconName) control.prepend(icon(iconName));
  if (className) control.className = className;
  control.addEventListener("click", onClick);
  return control;
};

// Buttons in the pages' markup ask for their icon with data-icon="send";
// links to other sites, class="external-link", are marked as such.
// (Tests import this module too, with no page around it.)
if (typeof document !== "undefined") {
  for (const control of document.querySelectorAll("[data-icon]")) {
    control.prepend(icon(control.dataset.icon));
  }
  for (const link of document.querySelectorAll("a.external-link")) {
    link.append(icon("external", 14));
  }
}

/**
 * Puts text on the clipboard: through the Clipboard API on HTTPS pages (and
 * localhost), the only places browsers offer it; elsewhere, such as an
 * instance reached by plain http on a home network, the old way.
 */
export const copyText = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.className = "clipboard-fallback";
  document.body.append(fallback);
  fallback.select();
  // execCommand is deprecated, and still the only copy a page without HTTPS has.
  // Reached through Reflect so that editors do not flag this deliberate use.
  const execCommand = Reflect.get(document, "execCommand");
  const copied = execCommand.call(document, "copy");
  fallback.remove();
  if (!copied) throw new Error("The browser blocked clipboard access.");
};

export const asPng = async (blob) => {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("The image could not be converted."))),
      "image/png",
    );
  });
};

const carriesFiles = (event) => event.dataTransfer?.types.includes("Files") ?? false;

/**
 * Lets a file be dropped on `zone` as well as picked: the drop fills `input`
 * as the picker would (one file, the first), and the form still waits for
 * its button. A file dropped anywhere else on the page is ignored, where the
 * browser would otherwise leave the page to open it.
 */
export const acceptDrops = (zone, input) => {
  let depth = 0;
  const highlight = (on) => zone.classList.toggle("dropping", on);
  zone.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event) || input.disabled) return;
    event.preventDefault();
    depth += 1;
    highlight(true);
  });
  zone.addEventListener("dragover", (event) => {
    if (!carriesFiles(event) || input.disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) highlight(false);
  });
  zone.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    highlight(false);
    // A field for several files takes every one dropped; any other, the first.
    const files = [...event.dataTransfer.files].slice(0, input.multiple ? undefined : 1);
    if (!files.length || input.disabled) return;
    const picked = new DataTransfer();
    for (const file of files) picked.items.add(file);
    input.files = picked.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
  });
};

/** Drops outside every zone do nothing, instead of opening the file in place of the page. */
export const ignoreStrayDrops = () => {
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      if (carriesFiles(event)) event.preventDefault();
    });
  }
};

/** Several files in a few words: "3 files · 1.2 MB". */
const describeFiles = (files) => {
  if (files.length === 1) return `${files[0].name} · ${formatBytes(files[0].size)}`;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return `${files.length} files · ${formatBytes(total)}`;
};

/**
 * A file field shown as its drop zone, a <label> for the hidden input: a
 * click picks files, a drop gives them, and the zone then names them, back
 * to its first words once the form is cleared.
 */
export const fileField = (input, zone) => {
  const empty = zone.textContent.trim();
  const show = () => {
    const files = [...(input.files ?? [])];
    zone.textContent = files.length ? describeFiles(files) : empty;
    zone.title = files.map((file) => file.name).join("\n");
    zone.classList.toggle("chosen", files.length > 0);
  };
  input.addEventListener("change", show);
  // A reset clears the input without a change event; show it once it is done.
  input.form?.addEventListener("reset", () => setTimeout(show));
  acceptDrops(zone, input);
};

/** What a restore did, in one sentence: {restored, skipped, rejected, namespaces}. */
const restoredMessage = ({ restored, skipped, rejected, namespaces }) => {
  const notes = [skipped ? `${skipped} already there` : "", rejected ? `${rejected} refused` : ""];
  const said = notes.filter(Boolean);
  return `Restored ${restored} item${restored === 1 ? "" : "s"}${
    namespaces > 1 ? ` in ${namespaces} namespaces` : ""
  }${said.length ? ` (${said.join(", ")})` : ""}.`;
};

/**
 * A backup's restore form: its file field (picked or dropped), the request,
 * and what came of it in `status`. `send(file)` posts the backup and returns
 * the server's answer; `done()` follows a restore that worked.
 */
export const restoreForm = ({ form, input, zone, status, send, done }) => {
  fileField(input, zone);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = input.files?.[0];
    if (!file) return;
    setBusy(form, true);
    status.progress(`Restoring ${file.name}…`);
    try {
      status.success(restoredMessage(await send(file)));
      form.reset();
      await done?.();
    } catch (error) {
      status.error(error.message);
    } finally {
      setBusy(form, false);
    }
  });
};
