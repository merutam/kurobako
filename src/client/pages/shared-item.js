// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { openSharedItem, textDownloadName } from "../../../public/k.mjs";
import { objectAddress, SVG_TYPE, svgAddress } from "../lib/addresses.js";
import { bundleView } from "../lib/bundle-view.js";
// The page behind a share link, /i/<token>: one item, and nothing that leads
// back to its namespace. Encrypted items carry their own key after the #.
import { button, compactText, copyText, element, request } from "../lib/common.js";
import {
  audioPlayer,
  canCopyImages,
  copyImage,
  describeOpened,
  describePlain,
  downloadBlob,
  highlightedText,
  limitedItem,
  streamAddress,
  videoPlayer,
} from "../lib/items.js";
import { createStatus } from "../lib/status.js";
import { failUnlocking, finishUnlocking } from "../lib/unlocking.js";
import { h } from "../shared/dom.js";
import { itemMeta, localizeDates } from "../shared/item-row.js";

const title = element("#item-title");
const meta = element("#item-meta");
const section = element("#item");
const body = element("#item-body");
const actions = element("#item-actions");
const status = createStatus(element("#status"));

const keyText = decodeURIComponent(window.location.hash.slice(1));
/** This page is /i/<token>: the contents are at /c, a download at /d. */
const here = window.location.pathname.replace(/\/$/, "");
const GONE = "This item is no longer available.";

/** The same description the namespace page uses, plus how to read the contents. */
const describe = async (item) => {
  if (item.kind !== "sealed") return { ...describePlain(item), decrypt: null };
  if (!keyText) throw new Error("Incomplete link: the part after # is missing.");
  const { metadata, open, bodyKey } = await openSharedItem(keyText, item.metadata, item.size);
  return { ...describeOpened(metadata), decrypt: open, bodyKey };
};

const fetchBytes = async (url, info) => {
  const bytes = await (await request(url, { cache: "no-store" })).arrayBuffer();
  return info.decrypt ? info.decrypt(bytes) : new Uint8Array(bytes);
};

/** Reads the contents; for burn-after-reading items this is the one read. */
const loadContent = async (item, info) => {
  if (info.kind === "text") {
    if (item.text !== undefined) return { text: item.text };
    return { text: new TextDecoder().decode(await fetchBytes(`${here}/c`, info)) };
  }
  const bytes = await fetchBytes(`${here}/c`, info);
  return { bytes, blob: new Blob([bytes], { type: info.mime || "application/octet-stream" }) };
};

const showContent = (item, info, content) => {
  if (content.text !== undefined) {
    body.replaceChildren(highlightedText(content.text, info.title));
    title.textContent = compactText(content.text).slice(0, 120);
  } else if (info.isImage) {
    const src = info.mime === SVG_TYPE ? svgAddress(content.bytes) : objectAddress(content.blob);
    body.replaceChildren(h("img", { alt: info.title, src }));
  } else if (info.isVideo) {
    body.replaceChildren(videoPlayer(objectAddress(content.blob)));
  } else if (info.isAudio) {
    body.replaceChildren(audioPlayer(objectAddress(content.blob)));
  } else if (info.isBundle) {
    body.replaceChildren(bundleView(content.bytes));
  } else {
    body.replaceChildren();
  }

  actions.replaceChildren();
  if (content.text !== undefined) {
    actions.append(
      button(
        "Copy",
        async () => {
          try {
            await copyText(content.text);
            status.success("Copied.");
          } catch (error) {
            status.error(error.message);
          }
        },
        undefined,
      ),
      button(
        "Save",
        () =>
          downloadBlob(
            new Blob([content.text], { type: "text/plain;charset=utf-8" }),
            textDownloadName(limitedItem(item) ? "" : info.title, item.id),
          ),
        "primary",
      ),
    );
  }
  if (info.isImage && canCopyImages()) {
    actions.append(
      button(
        "Copy",
        async () => {
          try {
            await copyImage(content.blob);
            status.success("Copied.");
          } catch (error) {
            status.error(error.message);
          }
        },
        undefined,
      ),
    );
  }
  if (content.blob) {
    actions.append(button("Save", () => downloadBlob(content.blob, info.filename), "primary"));
  }
};

const describeMeta = (item, info, opened) => {
  meta.replaceChildren(...itemMeta(h, item, info, opened));
};

// The server embeds the item in the page: null once it is gone, which the
// page already says (shared-item.tsx).
const item = JSON.parse(element("#item-data").textContent);
if (item) await showItem(item);

async function showItem(item) {
  try {
    const info = await describe(item);

    if (item.kind === "sealed") {
      // Only the key in the fragment tells what an encrypted item is.
      title.textContent = info.title;
      document.title = `${info.title} · Kurobako`;
      describeMeta(item, info, false);
      section.hidden = false;
    } else {
      // A plain item comes described by the server (shared-item.tsx).
      localizeDates(meta);
    }

    if (section.dataset.ssrRendered && item.kind !== "sealed" && !limitedItem(item)) {
      // Keep the server's native media elements and text in place. In particular,
      // do not fetch an image or a large text a second time during startup.
      if (info.kind === "text") {
        const displayed = body.textContent;
        body.replaceChildren(highlightedText(displayed, info.title));
        actions.prepend(
          button(
            "Copy",
            async () => {
              try {
                // HTML parsing may normalize line endings. Read the original
                // bytes only when copying a text that was stored externally.
                const text =
                  item.text ?? (await (await request(`${here}/c`, { cache: "no-store" })).text());
                await copyText(text);
                status.success("Copied.");
              } catch (error) {
                status.error(error.message);
              }
            },
            undefined,
          ),
        );
      } else if (info.isBundle) {
        // Its texts and files, shown; the server's Download stays for the tar.
        body.replaceChildren(bundleView(await fetchBytes(`${here}/c`, info)));
      } else if (info.isImage && canCopyImages()) {
        actions.prepend(
          button(
            "Copy",
            async () => {
              try {
                const blob = new Blob([await fetchBytes(`${here}/c`, info)], { type: info.mime });
                await copyImage(blob);
                status.success("Copied.");
              } catch (error) {
                status.error(error.message);
              }
            },
            undefined,
          ),
        );
      }
    } else if (limitedItem(item)) {
      // Never on page load: link previews and accidental visits must not burn it.
      body.replaceChildren();
      actions.replaceChildren(
        button(
          item.readsLeft ? `Open (${item.readsLeft} left)` : "Open once",
          async () => {
            try {
              const content = await loadContent(item, info);
              describeMeta(item, info, true);
              showContent(item, info, content);
              status.success(
                item.burn || item.readsLeft === 1
                  ? "Opened and deleted from the server."
                  : "Opened; one read used.",
              );
            } catch (error) {
              status.error(error.message === "Item not found." ? GONE : error.message);
            }
          },
          "primary",
        ),
      );
    } else if (item.kind === "file") {
      // A plain file: link to it rather than fetching it all just for a button.
      // A video plays straight from the server, in parts as it goes.
      body.replaceChildren(
        ...(info.isVideo
          ? [videoPlayer(`${here}/c`)]
          : info.isAudio
            ? [audioPlayer(`${here}/c`)]
            : []),
      );
      actions.replaceChildren(h("a", { class: "button primary", href: `${here}/d` }, "Save"));
    } else {
      // An encrypted file other than an image: read in parts, through the
      // Service Worker, rather than whole on opening the page.
      const address =
        item.kind === "sealed" && info.kind === "file" && !info.isImage && !info.isBundle
          ? await streamAddress({
              url: `${window.location.origin}${here}/c`,
              key: await info.bodyKey(),
              sealedSize: item.size,
              size: info.size,
              mime: info.mime || "application/octet-stream",
              filename: info.filename || "file",
            })
          : null;
      if (address) {
        body.replaceChildren(
          ...(info.isVideo ? [videoPlayer(address)] : info.isAudio ? [audioPlayer(address)] : []),
        );
        actions.replaceChildren(
          h("a", { class: "button primary", href: `${address}?download` }, "Save"),
        );
      } else {
        showContent(item, info, await loadContent(item, info));
      }
    }
    status.clear();
    finishUnlocking();
  } catch (error) {
    title.textContent = "Shared item";
    if (document.querySelector("#page-loading")) failUnlocking(error.message);
    else status.error(error.message);
  }
}
