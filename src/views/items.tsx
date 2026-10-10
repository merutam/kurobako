// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

export type ListedItem = {
  kind: "text" | "image" | "file" | "sealed";
  createdAt: string;
  size: number;
  name?: string;
  filename?: string;
  mime?: string;
  text?: string;
  preview?: string;
  burn?: boolean;
  readsLeft?: number;
};

export const formatBytes = (size: number) => {
  if (size < 1000) return `${size} B`;
  const units = ["kB", "MB", "GB"];
  let value = size / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
};

const age = (date: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
};

export const titleOf = (item: ListedItem) => {
  if (item.kind !== "text") return item.filename ?? "file";
  if (item.name) return item.name;
  if (item.burn || item.readsLeft !== undefined) return "Hidden until opened";
  return (item.text ?? item.preview ?? "").replace(/\s+/gu, " ").trim() || "(blank)";
};

const kindOf = (item: ListedItem) => {
  if (item.burn || item.readsLeft !== undefined) return "burn";
  if (item.kind === "image") return "image";
  if (item.mime?.startsWith("video/")) return "video";
  if (item.mime?.startsWith("audio/")) return "audio";
  return item.kind;
};

export const ItemRow = ({
  item,
  position,
  href,
  id,
}: {
  item: ListedItem;
  position: number;
  href: string;
  id?: string;
}) => {
  const limited = item.burn || item.readsLeft !== undefined;
  return (
    <li class={limited ? "item burn" : "item"} data-ssr-id={id}>
      <div class="item-row">
        <span class="item-position">{position}</span>
        {limited ? (
          <span class="item-toggle">
            <span class="item-kind" data-icon={kindOf(item)} aria-hidden="true" />
            <span class="item-title">{titleOf(item)}</span>
          </span>
        ) : (
          <a class="item-toggle" href={href}>
            <span class="item-kind" data-icon={kindOf(item)} aria-hidden="true" />
            <span class="item-title">{titleOf(item)}</span>
          </a>
        )}
        <span class="item-facts">
          {formatBytes(item.size)} ·{" "}
          <span data-created-at={item.createdAt}>{age(item.createdAt)}</span>
        </span>
        <span class="item-actions" />
      </div>
    </li>
  );
};

export const ItemRows = ({
  entries,
}: {
  entries: ReadonlyArray<{ item: ListedItem; href: string; id?: string }>;
}) => (
  <>
    {entries.map(({ item, href, id }, index) => (
      <ItemRow item={item} position={index + 1} href={href} id={id} />
    ))}
  </>
);
