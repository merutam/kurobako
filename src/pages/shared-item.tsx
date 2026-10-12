// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { describePlain, itemMeta } from "../client/shared/item-row.js";
import { readLimitedItem, type StoredItem, sharedItem } from "../core/model";
import { h } from "./components/html";
import { titleOf } from "./components/items";
import { Layout, type SiteView } from "./components/layout";

type PlainItem = Exclude<StoredItem, { kind: "sealed" }>;

const SharedItemContent = ({
  item,
  text,
  url,
}: {
  item: PlainItem;
  text: string | null;
  url: string;
}) => {
  const limited = readLimitedItem(item);
  const title = titleOf(item);
  // As the browser sees it (item-data), so both write the same line.
  const shared = sharedItem(item);
  const media =
    item.kind === "image"
      ? "image"
      : item.mime.startsWith("video/")
        ? "video"
        : item.mime.startsWith("audio/")
          ? "audio"
          : null;
  return (
    <>
      <h1 id="item-title">{title}</h1>
      <p class="intro">
        <span id="item-meta">{itemMeta(h, shared, describePlain(shared))}</span>
        {" · "}
        <a href={`${url}/ls`}>As JSON</a>
      </p>
      <p id="status" class="status" role="status" aria-live="polite" />
      <section
        id="item"
        class="shared-item stack"
        aria-labelledby="item-title"
        data-ssr-rendered={item.kind === "text" && !limited && text === null ? undefined : "true"}
      >
        <div id="item-body">
          {!limited && item.kind === "text" && text !== null ? <pre>{text}</pre> : null}
          {!limited && media === "image" ? <img src={`${url}/c`} alt={title} /> : null}
          {!limited && media === "video" ? (
            // biome-ignore lint/a11y/useMediaCaption: Uploaded media has no accompanying caption track.
            <video src={`${url}/c`} controls preload="metadata" playsInline />
          ) : null}
          {!limited && media === "audio" ? (
            // biome-ignore lint/a11y/useMediaCaption: Uploaded audio has no accompanying transcript track.
            <audio src={`${url}/c`} controls preload="metadata" />
          ) : null}
        </div>
        <p id="item-actions" class="actions">
          {limited ? (
            <button type="button" id="open-limited-item" class="primary">
              {item.readsLeft ? `Open (${item.readsLeft} left)` : "Open once"}
            </button>
          ) : null}
          {!limited ? (
            <a class="button primary" href={`${url}/d`}>
              Save
            </a>
          ) : null}
        </p>
      </section>
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
  /** Null once it is gone. */
  item: StoredItem | null;
  /** A plain text's contents, when they are not inline in `item`. */
  text: string | null;
  url: string;
}) => (
  <Layout
    site={site}
    title="Shared item · Kurobako"
    scripts={["shared-item"]}
    data={{ id: "item-data", value: item ? sharedItem(item) : null }}
    noIndex
    // An encrypted item shows only once decrypted, as a namespace does.
    decrypting={item?.kind === "sealed" ? "Decrypting item…" : undefined}
  >
    {item && item.kind !== "sealed" ? (
      <SharedItemContent item={item} text={text} url={url} />
    ) : (
      <>
        <h1 id="item-title">Shared item</h1>
        <p class="intro">
          <span id="item-meta">
            {item ? null : "This shared item is gone: deleted, expired or already read."}
          </span>
          {item ? (
            <>
              {" · "}
              <a href={`${url}/ls`}>As JSON</a>
            </>
          ) : null}
        </p>
        <p id="status" class="status" role="status" aria-live="polite" />
        <section id="item" class="shared-item stack" aria-labelledby="item-title" hidden>
          <div id="item-body" />
          <p id="item-actions" class="actions" />
        </section>
      </>
    )}
  </Layout>
);
