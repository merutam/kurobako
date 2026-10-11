// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The server's h (see public/dom.js): the markup the browser shares with the
// server (public/item-row.js, public/icons.js), as HTML text JSX can take.
import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type Child = string | number | HtmlEscapedString | null | undefined | false | Child[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeText = (text: string) =>
  text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");

const isEscaped = (child: unknown): child is HtmlEscapedString =>
  typeof child === "object" && child !== null && "isEscaped" in child;

const childHtml = (child: Child): string => {
  if (child === null || child === undefined || child === false) return "";
  if (Array.isArray(child)) return child.map(childHtml).join("");
  return isEscaped(child) ? String(child) : escapeText(String(child));
};

export const h = (
  tag: string,
  attributes: Record<string, unknown> = {},
  ...children: Child[]
): HtmlEscapedString => {
  let html = `<${tag}`;
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    html += value === true ? ` ${name}` : ` ${name}="${escapeText(String(value))}"`;
  }
  return raw(`${html}>${childHtml(children)}</${tag}>`);
};
