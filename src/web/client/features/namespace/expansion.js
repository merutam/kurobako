// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Which rows are open: one at a time, several, or all, remembered on this device.
import { choiceGroup, storage } from "../../lib/common.js";

const MODES = ["one", "several", "all"];
const MODE_KEY = "kurobako-expand";

/** `order` lists the item IDs as shown, so "one" keeps the topmost open one. */
export const createExpansion = ({ choices, order }) => {
  let mode = MODES.includes(storage.get(MODE_KEY)) ? storage.get(MODE_KEY) : "one";
  const expanded = new Set();
  /** In "all", the ones closed by hand. */
  const closed = new Set();
  /** Each shown row's way to open or close itself. */
  const openers = new Map();

  const isExpanded = (id) => (mode === "all" ? !closed.has(id) : expanded.has(id));
  const closeOthers = () => {
    for (const id of expanded) openers.get(id)?.(false);
    expanded.clear();
  };

  choiceGroup(choices, mode, (picked) => {
    mode = picked;
    storage.set(MODE_KEY, mode);
    closed.clear();
    if (mode === "one" && expanded.size > 1) {
      const keep = order().find((id) => expanded.has(id));
      expanded.clear();
      if (keep) expanded.add(keep);
    }
    for (const [id, setOpen] of openers) setOpen(isExpanded(id));
  });

  return {
    isExpanded,
    register: (id, setOpen) => openers.set(id, setOpen),
    unregister: (id) => openers.delete(id),
    /** Flips a row, as its toggle does; returns whether it is now open. */
    toggle(id) {
      const open = !isExpanded(id);
      if (mode === "all") {
        if (open) closed.delete(id);
        else closed.add(id);
      } else if (open) {
        if (mode === "one") closeOthers();
        expanded.add(id);
      } else {
        expanded.delete(id);
      }
      return open;
    },
    /** Opened by the page (a notification's copy), closing others in "one". */
    reveal(id) {
      if (mode === "one") closeOthers();
      expanded.add(id);
      closed.delete(id);
      openers.get(id)?.(true);
    },
    /** Marked open for its next render, as an item just read once. */
    keepOpen: (id) => expanded.add(id),
    forget: (id) => expanded.delete(id),
  };
};
