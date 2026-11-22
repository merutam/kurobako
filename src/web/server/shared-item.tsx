// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { readLimitedItem, type StoredItem, sharedItem } from "../../domain/model";
import { describePlain, kindOf } from "../client/shared/item-row.js";
import { h } from "./components/html";
import { ItemsSection, sharedItemRow, titleOf } from "./components/items";
import { Layout, type SiteView } from "./components/layout";
import { MediaFeed } from "./components/media-feed";

type PlainItem = Exclude<StoredItem, { kind: "sealed" }>;

/** What the open row shows before any script: the text, or the medium itself. */
const contentOf = (item: PlainItem, text: string | null, url: string) => {
  if (readLimitedItem(item)) return null;
  if (item.kind === "text") return text === null ? null : h("pre", {}, text);
  const kind = kindOf(describePlain(item));
  if (kind === "image") return h("img", { src: `${url}/c`, alt: titleOf(item) });
  if (kind === "video")
    return h("video", { src: `${url}/c`, controls: true, preload: "metadata", playsinline: true });
  if (kind === "audio") return h("audio", { src: `${url}/c`, controls: true, preload: "metadata" });
  return null;
};

/** As a shared view's list, with one row, open. */
const SharedItemContent = ({
  item,
  text,
  url,
}: {
  item: PlainItem;
  text: string | null;
  url: string;
}) => {
  // As the browser sees it (item-data), so both make the same row.
  const shared = sharedItem(item);
  const token = url.split("/").pop() ?? "";
  return (
    <>
      <h1 id="item-title">Shared item</h1>
      <p class="intro">
        <a href={`${url}/ls`}>As JSON</a>
      </p>
      <p id="status" class="status" role="status" aria-live="polite" />
      <MediaFeed />
      <ItemsSection
        rows={sharedItemRow({ ...shared, id: token }, url, contentOf(item, text, url))}
        size={1}
        count="1"
        single
      />
      {readLimitedItem(item) ? (
        // Opening spends a read: a form, so neither link prefetching nor crawlers do.
        <noscript>
          <form id="open-limited-item" method="get" action={`${url}/d`}>
            <button type="submit" class="primary">
              {item.readsLeft ? `Open (${item.readsLeft} left)` : "Open once"}
            </button>
          </form>
        </noscript>
      ) : null}
    </>
  );
};

export const SharedItemPage = ({
  site,
  item,
  text,
  url,
}: {
  site: SiteView;
  item: StoredItem | null;
  /** When they are not inline in `item`. */
  text: string | null;
  url: string;
}) => (
  <Layout
    site={site}
    title="Shared item · Kurobako"
    scripts={["shared-item"]}
    data={{ id: "item-data", value: item ? sharedItem(item) : null }}
    noIndex
    decrypting={item?.kind === "sealed" ? "Decrypting item…" : undefined}
  >
    {item && item.kind !== "sealed" ? (
      <SharedItemContent item={item} text={text} url={url} />
    ) : (
      <>
        <h1 id="item-title">Shared item</h1>
        <p class="intro">
          {item ? (
            <a href={`${url}/ls`}>As JSON</a>
          ) : (
            "This shared item is gone: deleted, expired or already read."
          )}
        </p>
        <p id="status" class="status" role="status" aria-live="polite" />
        {item ? (
          <>
            <MediaFeed />
            <ItemsSection rows={null} size={0} count="" known={false} single />
          </>
        ) : null}
      </>
    )}
  </Layout>
);
