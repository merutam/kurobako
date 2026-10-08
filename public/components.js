// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Light-DOM components.
import { formatBytes } from "./common.js";

const carriesFiles = (event) => event.dataTransfer?.types.includes("Files") ?? false;

const describeFiles = (files) => {
  if (files.length === 1) return `${files[0].name} · ${formatBytes(files[0].size)}`;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return `${files.length} files · ${formatBytes(total)}`;
};
const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(2)} MB`;

// Interaction shared by file fields.
class KFileField extends HTMLElement {
  #listeners = null;
  #placeholder = null;

  connectedCallback() {
    if (this.#listeners) return;
    const input = this.querySelector('input[type="file"]');
    const zone = this.querySelector("label.dropzone");
    if (!input || !zone || zone.htmlFor !== input.id) {
      throw new Error("A k-file-field needs a file input and its drop-zone label.");
    }

    this.#placeholder ??= zone.textContent.trim();
    const selected = this.querySelector(".file-selection") ?? document.createElement("ul");
    if (input.multiple && !selected.isConnected) {
      selected.className = "file-selection";
      selected.setAttribute("aria-live", "polite");
      selected.hidden = true;
      this.append(selected);
    }
    const listeners = new AbortController();
    this.#listeners = listeners;
    const options = { signal: listeners.signal };
    const show = () => {
      const files = [...(input.files ?? [])];
      zone.textContent = files.length ? describeFiles(files) : this.#placeholder;
      zone.title = files.map((file) => file.name).join("\n");
      zone.classList.toggle("chosen", files.length > 0);
      if (input.multiple) {
        selected.replaceChildren();
        for (const file of files) {
          const row = document.createElement("li");
          const name = document.createElement("span");
          name.textContent = file.name;
          const size = document.createElement("span");
          size.textContent = megabytes(file.size);
          row.append(name, size);
          selected.append(row);
        }
        if (files.length) {
          const total = document.createElement("li");
          total.className = "file-selection-total";
          const label = document.createElement("span");
          label.textContent = `${files.length} file${files.length === 1 ? "" : "s"} total`;
          const size = document.createElement("span");
          size.textContent = megabytes(files.reduce((sum, file) => sum + file.size, 0));
          total.append(label, size);
          selected.append(total);
        }
        selected.hidden = files.length === 0;
      }
    };
    const highlight = (on) => zone.classList.toggle("dropping", on);
    let depth = 0;

    input.addEventListener("change", show, options);
    // The browser clears the input after the reset event, not during it.
    input.form?.addEventListener("reset", () => setTimeout(show), options);
    zone.addEventListener(
      "dragenter",
      (event) => {
        if (!carriesFiles(event) || input.disabled) return;
        event.preventDefault();
        depth += 1;
        highlight(true);
      },
      options,
    );
    zone.addEventListener(
      "dragover",
      (event) => {
        if (!carriesFiles(event) || input.disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      options,
    );
    zone.addEventListener(
      "dragleave",
      () => {
        depth = Math.max(0, depth - 1);
        if (!depth) highlight(false);
      },
      options,
    );
    zone.addEventListener(
      "drop",
      (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth = 0;
        highlight(false);
        if (input.disabled) return;
        const files = [...event.dataTransfer.files].slice(0, input.multiple ? undefined : 1);
        if (!files.length) return;
        const picked = new DataTransfer();
        for (const file of files) picked.items.add(file);
        input.files = picked.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.focus();
      },
      options,
    );
    show();
  }

  disconnectedCallback() {
    this.#listeners?.abort();
    this.#listeners = null;
  }
}

customElements.define("k-file-field", KFileField);

/** Drops outside a file field must not replace the current page. */
export const ignoreStrayDrops = () => {
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      if (carriesFiles(event)) event.preventDefault();
    });
  }
};
