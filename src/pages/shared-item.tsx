// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { readLimitedItem, type StoredItem, sharedItem } from "../core/model";
import { formatBytes, titleOf } from "./components/items";
import { Page, type SiteView } from "./components/layout";

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
      <p id="item-meta" class="intro">
        {item.kind === "text"
          ? "Text"
          : media === "image"
            ? "Image"
            : media === "video"
              ? "Video"
              : media === "audio"
                ? "Audio"
                : "File"}{" "}
        · {formatBytes(item.size)}
        {limited
          ? ` · ${item.readsLeft ? `${item.readsLeft} reads left` : "deletes when opened"}`
          : ""}
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
            <button type="button" id="open-limited-item">
              {item.readsLeft ? `Open (${item.readsLeft} left)` : "Open once"}
            </button>
          ) : null}
          {!limited ? (
            <a class="button" href={`${url}/d`}>
              Download
            </a>
          ) : null}
        </p>
      </section>
    </>
  );
};

export const renderSharedItemPage = (
  site: SiteView,
  item: StoredItem | null,
  text: string | null,
  url: string,
) =>
  Page({
    site,
    title: "Shared item · Kurobako",
    scripts: ["shared-item"],
    data: { id: "item-data", value: item ? sharedItem(item) : null },
    noIndex: true,
    children:
      item && item.kind !== "sealed" ? (
        <SharedItemContent item={item} text={text} url={url} />
      ) : (
        <>
          <h1 id="item-title">Shared item</h1>
          <p id="item-meta" class="intro" />
          <p id="status" class="status" role="status" aria-live="polite">
            {item ? "Decrypting item…" : "This shared item is gone."}
          </p>
          <section id="item" class="shared-item stack" aria-labelledby="item-title" hidden>
            <div id="item-body" />
            <p id="item-actions" class="actions" />
          </section>
        </>
      ),
  });
