// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Renaming an item in place, where its title was.
import { defaultTextName } from "../../../../sdk/k.mjs";
import { HIDDEN_TITLE } from "../../lib/common.js";
import { h } from "../../shared/dom.js";

/** `onCancel` and `onRenamed` let the list render again once the field is gone. */
export const createRenamer = ({ status, rename, onCancel, onRenamed }) => {
  /** Live updates wait until it is done. */
  let renaming = false;

  const start = (entry, title) => {
    const holder = title.closest(".item-toggle") ?? title.parentElement;
    const input = h("input", { type: "text", class: "rename-input", "aria-label": "New name" });
    // Keeping the default name changes nothing.
    const named = entry.info.kind !== "text" || Boolean(entry.item.name);
    const current = entry.info.title === HIDDEN_TITLE ? "" : entry.info.title;
    const initial = named ? current : defaultTextName(current);
    input.value = initial;
    renaming = true;
    holder.hidden = true;
    holder.before(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      input.remove();
      holder.hidden = false;
      renaming = false;
      if (!save || name === initial) {
        await onCancel();
        return;
      }
      try {
        await rename(entry.item, name);
        status.success("Renamed.");
      } catch (error) {
        status.error(error.message);
      }
      await onRenamed();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  };

  return { start, active: () => renaming };
};
