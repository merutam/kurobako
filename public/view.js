// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { el, element, formatBytes, request, SITE } from "./common.js";
import { describeOpened, describePlain, limitedItem } from "./items.js";
import { openSealedSpace, openSharedItem, openViewEntry, secretNameProblem } from "./k.mjs";
import { createStatus } from "./status.js";

const status = createStatus(element("#view-status"));
const list = element("#view-items");
const view = JSON.parse(element("#view-data").textContent);
const viewKey = decodeURIComponent(window.location.hash.slice(1));

const describeEntry = async (entry) => {
  if (entry.item.kind !== "sealed")
    return { info: describePlain(entry.item), itemKey: "", open: null };
  if (!viewKey) throw new Error("Incomplete link: its view key is missing after #.");
  const itemKey = await openViewEntry(view.viewId, viewKey, entry.envelope);
  const opened = await openSharedItem(itemKey, entry.item.metadata, entry.item.size);
  return { info: describeOpened(opened.metadata), itemKey, open: opened.open };
};

const show = async () => {
  if (!view) throw new Error("This shared view is no longer available.");
  if (!view.entries.length) {
    status.progress("No available items in this view.");
    return;
  }
  for (const entry of view.entries) {
    const { info, itemKey } = await describeEntry(entry);
    const href = `${entry.url}${itemKey ? `#${itemKey}` : ""}`;
    list.append(
      el(
        "li",
        {},
        el("a", { href }, info.title || "Untitled"),
        el("span", { className: "hint" }, ` · ${formatBytes(info.size)}`),
      ),
    );
  }
  status.clear();
};

show().catch((error) => status.error(error.message));

/** Each item is checked again before copying: a live view is not an atomic snapshot. */
const clone = async (event) => {
  event.preventDefault();
  const form = element("#clone-form");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  let copied = 0;
  let skipped = 0;
  let destination = "";
  try {
    const name = element("#clone-name").value.trim();
    const encrypted = element("#clone-mode").value === "sealed";
    if (encrypted) {
      const problem = secretNameProblem(name);
      if (problem) throw new Error(problem);
    }
    const space = encrypted ? await openSealedSpace(name) : null;
    destination = encrypted ? `${SITE}/e/${space.id}` : `${SITE}/${encodeURIComponent(name)}`;
    const headers = space ? { "Write-Key": space.writeKey } : {};
    const existing = await (await request(`${destination}/views`, { headers })).json();
    if (existing.items.length || existing.views.length) {
      throw new Error("Choose a new, empty destination namespace.");
    }
    // Capture membership when cloning starts, not when this page was opened.
    const current = await (
      await request(`${window.location.pathname}.json`, { cache: "no-store" })
    ).json();
    if (current.viewId !== view.viewId) throw new Error("The shared view changed.");
    const includeLimited = element("#clone-limited").checked;
    for (const entry of [...current.entries].reverse()) {
      if (limitedItem(entry.item) && !includeLimited) {
        skipped += 1;
        continue;
      }
      status.progress(`Cloning… ${copied} copied, ${skipped} skipped.`);
      const before = await (await request(`${entry.url}.json`, { cache: "no-store" })).json();
      const { info, open } = await describeEntry({ ...entry, item: before });
      const response = await request(`${entry.url}/c`, { cache: "no-store" });
      const sealed = new Uint8Array(await response.arrayBuffer());
      const bytes = open ? await open(sealed) : sealed;
      if (!limitedItem(before)) {
        const after = await (await request(`${entry.url}.json`, { cache: "no-store" })).json();
        if ((after.updatedAt ?? after.createdAt) !== (before.updatedAt ?? before.createdAt)) {
          skipped += 1;
          continue;
        }
      }
      const isText = info.kind === "text";
      const cloneTitle = isText && limitedItem(before) ? "" : info.title;
      let saved;
      if (space) {
        const metadata = isText
          ? { kind: "text", title: cloneTitle, size: bytes.byteLength }
          : {
              kind: "file",
              title: info.title,
              filename: info.filename,
              mime: info.mime,
              size: bytes.byteLength,
            };
        const sent = await space.sealItem(bytes, metadata);
        saved = await request(`${destination}/new`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "X-Sealed-Metadata": sent.header,
          },
          body: sent.body,
        });
      } else if (isText) {
        saved = await request(`${destination}/new`, {
          method: "POST",
          headers: { "Content-Type": "text/plain; charset=utf-8", "No-Dedup": "1" },
          body: bytes,
        });
        const item = await saved.json();
        if (!limitedItem(before) && info.title && info.title !== item.name) {
          await request(`${destination}/${item.id}/n`, {
            method: "POST",
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: info.title,
          });
        }
      } else {
        saved = await request(`${destination}/new`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": encodeURIComponent(info.filename || "file"),
            "No-Dedup": "1",
          },
          body: bytes,
        });
      }
      copied += 1;
    }
    status.success(
      `Clone complete: ${copied} copied, ${skipped} skipped. Open ${encrypted ? `/e#${name}` : destination}.`,
    );
  } catch (error) {
    status.error(
      `Clone incomplete: ${copied} copied, ${skipped} skipped${destination ? ` in ${destination}` : ""}. ${error.message}`,
    );
  } finally {
    button.disabled = false;
  }
};

element("#clone-form").addEventListener("submit", clone);
