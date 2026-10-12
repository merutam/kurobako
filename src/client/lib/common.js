// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { h } from "../shared/dom.js";
import { imageAddress, SVG_TYPE } from "./addresses.js";

export {
  compactText,
  dateFormatter,
  formatAge,
  formatBytes,
  formatDuration,
  formatExpiry,
  HIDDEN_TITLE,
  numberFormatter,
} from "../shared/format.js";

export const element = (selector) => {
  const found = document.querySelector(selector);
  if (!found) throw new Error("Something went wrong. Reload the page.");
  return found;
};

/** From <html data-base>: scripts live under /k/assets/, so their own address cannot tell. */
export const SITE = globalThis.document?.documentElement.dataset.base ?? "";

export const setBusy = (form, busy) => {
  for (const control of form.elements) control.disabled = busy;
};

export const setupNamespaceField = (field, hint, config, onModeChange = () => {}) => {
  const input = field.querySelector('input[type="text"]');
  const encrypted = field.querySelector('.e2ee-control input[type="checkbox"]');
  const prefix = field.querySelector(".namespace-prefix");
  const update = () => {
    const sealed = encrypted.checked;
    input.placeholder = sealed ? "a long secret name" : "myns";
    input.maxLength = sealed ? config.sealed.maxNameLength : config.namespace.maxLength;
    prefix.textContent = sealed ? "/e#" : "/";
    hint.textContent = sealed
      ? `E2EE. Max ${config.sealed.maxNameLength} characters.`
      : `a-z, 0-9, _ and -. Max ${config.namespace.maxLength} characters.${encrypted.disabled ? " Encryption needs HTTPS." : ""}`;
    onModeChange();
  };
  if (!globalThis.crypto?.subtle) {
    encrypted.disabled = true;
    encrypted.checked = false;
  }
  encrypted.addEventListener("change", update);
  input.addEventListener("input", () => {
    if (encrypted.disabled) return;
    const typed = /^\/?e#/u.exec(input.value);
    if (!typed) return;
    input.value = input.value.slice(typed[0].length);
    encrypted.checked = true;
    update();
  });
  update();
};

/** Preferences only: private windows and blocked storage just forget them. */
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
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

/** Embedded in each page, so it needs no request. */
export const readConfig = () => JSON.parse(element("#config").textContent);

export class RequestError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const request = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    throw new RequestError(
      body.error || `Server error (${response.status}).`,
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  return response;
};

export const button = (label, onClick, className) => {
  const control = h("button", { type: "button", class: className }, label);
  control.addEventListener("click", onClick);
  return control;
};

/**
 * The Clipboard API exists only on HTTPS and localhost; plain-http home servers need the old way.
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
  // Deprecated, yet the only copy a page without HTTPS has. Through Reflect so
  // editors do not flag this deliberate use.
  const execCommand = Reflect.get(document, "execCommand");
  const copied = execCommand.call(document, "copy");
  fallback.remove();
  if (!copied) throw new Error("The browser blocked clipboard access.");
};

/** createImageBitmap does not take SVGs, so they go through an <img>. */
const decoded = async (blob) => {
  if (blob.type !== SVG_TYPE) return createImageBitmap(blob);
  const image = new Image();
  image.src = await imageAddress(blob);
  await image.decode();
  return image;
};

export const asPng = async (blob) => {
  if (blob.type === "image/png") return blob;
  const picture = await decoded(blob);
  const canvas = document.createElement("canvas");
  // An SVG without a size of its own is drawn at an <img>'s default one.
  canvas.width = picture.naturalWidth ?? picture.width;
  canvas.height = picture.naturalHeight ?? picture.height;
  canvas.getContext("2d").drawImage(picture, 0, 0);
  picture.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("The image could not be converted."))),
      "image/png",
    );
  });
};

const restoredMessage = ({ restored, skipped, rejected, namespaces }) => {
  const notes = [skipped ? `${skipped} already there` : "", rejected ? `${rejected} refused` : ""];
  const said = notes.filter(Boolean);
  return `Restored ${restored} item${restored === 1 ? "" : "s"}${
    namespaces > 1 ? ` in ${namespaces} namespaces` : ""
  }${said.length ? ` (${said.join(", ")})` : ""}.`;
};

export const restoreForm = ({ form, input, status, send, done }) => {
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

/** A drop beside the field must not replace the page with the file. */
export const ignoreStrayDrops = () => {
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    });
  }
};

export const choiceGroup = (group, value, onPick) => {
  const buttons = [...group.querySelectorAll("[data-choice]")];
  const mark = (chosen) => {
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.choice === chosen));
    }
  };
  mark(value);
  for (const button of buttons) {
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-pressed") === "true") return;
      mark(button.dataset.choice);
      onPick(button.dataset.choice);
    });
  }
  return { mark };
};
