// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Markdown, shown: the common part of it (headings, paragraphs, lists and
// task lists, quotes, code, rules, tables, emphasis, links and images),
// written as elements, never as HTML. HTML in the text stays text, so a
// document cannot run or load anything. Links go to http(s), mailto, or a
// file beside the text in its bundle; images come only from that bundle
// (resolve), since the page loads nothing from elsewhere.

import { h } from "../shared/dom.js";
import { highlightedCode } from "./items.js";

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** Whether `line` starts a block other than a paragraph (which it ends). */
const startsBlock = (line, next) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  LIST.test(line) ||
  (line.includes("|") && next !== undefined && TABLE_DIVIDER.test(next) && next.includes("-"));

const cells = (line) => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (trimmed[index] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += trimmed[index];
  }
  out.push(cell.trim());
  return out;
};

/**
 * Renders `source` into a <div class="markdown-body">. `resolve(path)` gives a
 * file of the bundle as { url, type, name }, or null.
 */
export const renderMarkdown = (source, { resolve = () => null } = {}) => {
  /** A link's target, or null when it may not be one. */
  const target = (href) => {
    const trimmed = href.trim();
    if (/^(https?:|mailto:)/i.test(trimmed)) return { href: trimmed, external: true };
    const file = resolve(decodeURIComponent(trimmed.replace(/^\.\//, "")));
    if (file) return { href: file.url, download: file.name };
    if (trimmed.startsWith("#")) return { href: trimmed };
    return null;
  };

  const inline = (text) => {
    const out = [];
    let plain = "";
    const flush = () => {
      if (plain) out.push(plain);
      plain = "";
    };
    /** The index of the `]` that closes the `[` at `open`, or -1. */
    const closeBracket = (open) => {
      let depth = 0;
      for (let index = open; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === "[") depth += 1;
        else if (text[index] === "]") {
          depth -= 1;
          if (depth === 0) return index;
        }
      }
      return -1;
    };
    /** `(destination "title")` right after `close`: [destination, end], or null. */
    const destination = (close) => {
      if (text[close + 1] !== "(") return null;
      let depth = 0;
      for (let index = close + 1; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === "(") depth += 1;
        else if (text[index] === ")") {
          depth -= 1;
          if (depth > 0) continue;
          const inside = text.slice(close + 2, index).trim();
          // <a destination> or a plain one, with an optional "title".
          const match =
            /^<([^>]*)>(?:\s+["'(].*["')])?$/.exec(inside) ??
            /^(\S*)(?:\s+["'(].*["')])?$/.exec(inside);
          return match ? [match[1], index] : null;
        }
      }
      return null;
    };

    for (let index = 0; index < text.length; ) {
      const character = text[index];
      const rest = text.slice(index);

      if (character === "\\" && PUNCTUATION.test(text[index + 1] ?? "")) {
        plain += text[index + 1];
        index += 2;
        continue;
      }
      if (character === "\\" && text[index + 1] === "\n") {
        flush();
        out.push(h("br"));
        index += 2;
        continue;
      }
      if (character === "\n") {
        if (plain.endsWith("  ")) {
          plain = plain.trimEnd();
          flush();
          out.push(h("br"));
        } else plain += "\n";
        index += 1;
        continue;
      }
      if (character === "`") {
        const run = /^`+/.exec(rest)[0];
        const end = text.indexOf(run, index + run.length);
        if (end !== -1) {
          flush();
          const code = text.slice(index + run.length, end).replace(/\n/g, " ");
          out.push(
            h(
              "code",
              {},
              code.length > 2 && code.startsWith(" ") && code.endsWith(" ")
                ? code.slice(1, -1)
                : code,
            ),
          );
          index = end + run.length;
          continue;
        }
        plain += run;
        index += run.length;
        continue;
      }
      if (character === "!" && text[index + 1] === "[") {
        const close = closeBracket(index + 1);
        const link = close !== -1 && destination(close);
        if (link) {
          flush();
          const alt = text.slice(index + 2, close);
          const file = resolve(decodeURIComponent(link[0].replace(/^\.\//, "")));
          out.push(
            file?.type.startsWith("image/")
              ? h("img", { src: file.url, alt })
              : h(
                  "span",
                  { class: "markdown-missing", title: link[0] },
                  `[image: ${alt || link[0]}]`,
                ),
          );
          index = link[1] + 1;
          continue;
        }
      }
      if (character === "[") {
        const close = closeBracket(index);
        const link = close !== -1 && destination(close);
        if (link) {
          flush();
          const label = inline(text.slice(index + 1, close));
          const to = target(link[0]);
          out.push(
            to
              ? h(
                  "a",
                  {
                    href: to.href,
                    download: to.download,
                    target: to.external ? "_blank" : undefined,
                    rel: to.external ? "noopener noreferrer" : undefined,
                  },
                  label,
                )
              : h("span", { title: link[0] }, label),
          );
          index = link[1] + 1;
          continue;
        }
      }
      if (character === "<") {
        const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
        if (auto) {
          flush();
          out.push(
            h("a", { href: auto[1], target: "_blank", rel: "noopener noreferrer" }, auto[1]),
          );
          index += auto[0].length;
          continue;
        }
      }
      // A bare web address, as GitHub links them.
      if (
        (character === "h" || character === "w") &&
        /[\s(]$|^$/.test(text.slice(Math.max(0, index - 1), index))
      ) {
        const bare = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]]/i.exec(rest);
        if (bare) {
          flush();
          const href = bare[0].startsWith("www.") ? `https://${bare[0]}` : bare[0];
          out.push(h("a", { href, target: "_blank", rel: "noopener noreferrer" }, bare[0]));
          index += bare[0].length;
          continue;
        }
      }
      if (character === "*" || character === "_" || character === "~") {
        const run = /^(\*{1,3}|_{1,3}|~~)/.exec(rest)?.[0];
        const before = text[index - 1] ?? " ";
        // An underscore inside a word (snake_case) is no emphasis.
        const opens =
          run &&
          !/\s/.test(text[index + run.length] ?? " ") &&
          !(character === "_" && /\w/.test(before));
        if (opens) {
          let end = index + run.length;
          for (;;) {
            end = text.indexOf(run, end);
            if (end === -1) break;
            const after = text[end + run.length] ?? " ";
            if (!/\s/.test(text[end - 1]) && !(character === "_" && /\w/.test(after))) break;
            end += 1;
          }
          if (end !== -1 && end > index + run.length) {
            flush();
            const inner = inline(text.slice(index + run.length, end));
            out.push(
              run === "~~"
                ? h("del", {}, inner)
                : run.length === 3
                  ? h("strong", {}, h("em", {}, inner))
                  : run.length === 2
                    ? h("strong", {}, inner)
                    : h("em", {}, inner),
            );
            index = end + run.length;
            continue;
          }
        }
      }
      plain += character;
      index += 1;
    }
    flush();
    return out;
  };

  const blocks = (lines) => {
    const out = [];
    for (let index = 0; index < lines.length; ) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = FENCE.exec(line);
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
        const code = [];
        index += 1;
        while (index < lines.length && !close.test(lines[index])) code.push(lines[index++]);
        index += 1;
        const text = code.join("\n");
        out.push(
          h(
            "pre",
            {},
            fence[2]
              ? highlightedCode(text, `code.${fence[2].toLowerCase()}`)
              : h("code", {}, text),
          ),
        );
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        out.push(h(`h${heading[1].length}`, {}, inline(heading[2] ?? "")));
        index += 1;
        continue;
      }

      if (RULE.test(line)) {
        out.push(h("hr"));
        index += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        const quoted = [];
        while (
          index < lines.length &&
          lines[index].trim() &&
          (QUOTE.test(lines[index]) || quoted.length)
        ) {
          if (!QUOTE.test(lines[index]) && startsBlock(lines[index], lines[index + 1])) break;
          quoted.push(lines[index].replace(QUOTE, ""));
          index += 1;
        }
        out.push(h("blockquote", {}, blocks(quoted)));
        continue;
      }

      const item = LIST.exec(line);
      if (item) {
        const ordered = /\d/.test(item[2]);
        const items = [];
        let loose = false;
        while (index < lines.length) {
          const marker = LIST.exec(lines[index]);
          if (!marker || /\d/.test(marker[2]) !== ordered || marker[1].length > item[1].length + 1)
            break;
          const indent = marker[0].length || marker[1].length + marker[2].length + 1;
          const content = [lines[index].slice(marker[0].length)];
          index += 1;
          while (index < lines.length) {
            const next = lines[index];
            if (!next.trim()) {
              const after = lines[index + 1];
              if (after !== undefined && /^\s+/.test(after) && after.search(/\S/) >= indent) {
                content.push("");
                loose = true;
                index += 1;
                continue;
              }
              break;
            }
            if (next.search(/\S/) >= indent) content.push(next.slice(indent));
            else if (!LIST.test(next) && !startsBlock(next, lines[index + 1])) content.push(next);
            else break;
            index += 1;
          }
          items.push(content);
          if (!lines[index]?.trim() && LIST.test(lines[index + 1] ?? "")) {
            loose = true;
            index += 1;
          }
        }
        const start = ordered ? Number.parseInt(item[2], 10) : 1;
        out.push(
          h(
            ordered ? "ol" : "ul",
            { start: ordered && start !== 1 ? start : undefined },
            items.map((content) => {
              const task = /^\[([ xX])\] /.exec(content[0]);
              if (task) content[0] = content[0].slice(task[0].length);
              const body = blocks(content);
              // A tight list's items are their text, without paragraphs.
              const children = loose
                ? body
                : body.flatMap((node) => (node.tagName === "P" ? [...node.childNodes] : [node]));
              return h(
                "li",
                { class: task ? "task" : undefined },
                task
                  ? h("input", { type: "checkbox", disabled: true, checked: task[1] !== " " })
                  : null,
                children,
              );
            }),
          ),
        );
        continue;
      }

      if (
        line.includes("|") &&
        TABLE_DIVIDER.test(lines[index + 1] ?? "") &&
        lines[index + 1].includes("-")
      ) {
        const head = cells(line);
        const align = cells(lines[index + 1]).map((cell) =>
          cell.startsWith(":") && cell.endsWith(":")
            ? "center"
            : cell.endsWith(":")
              ? "right"
              : cell.startsWith(":")
                ? "left"
                : undefined,
        );
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          rows.push(cells(lines[index]));
          index += 1;
        }
        const cell = (tag, text, column) =>
          h(tag, { "data-align": align[column] }, inline(text ?? ""));
        out.push(
          h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "data-table" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  head.map((text, column) => cell("th", text, column)),
                ),
              ),
              h(
                "tbody",
                {},
                rows.map((row) =>
                  h(
                    "tr",
                    {},
                    head.map((_, column) => cell("td", row[column], column)),
                  ),
                ),
              ),
            ),
          ),
        );
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !startsBlock(lines[index], lines[index + 1])
      ) {
        paragraph.push(lines[index]);
        index += 1;
      }
      out.push(h("p", {}, inline(paragraph.map((part) => part.replace(/^ +/, "")).join("\n"))));
    }
    return out;
  };

  return h(
    "div",
    { class: "markdown-body" },
    blocks(source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")),
  );
};

/** Whether a text by this name is Markdown. */
export const isMarkdown = (name) => /\.(?:md|markdown)$/i.test(name ?? "");
