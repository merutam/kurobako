// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The files the composer holds: picked, dropped or pasted, listed with their
// sizes, and renamed so a text can refer to them as they are.
import { ASSETS, uniqueNames } from "../../../../protocol/bundle.js";
import { safeName } from "../../../../sdk/k.mjs";
import { copyText, element, formatBytes } from "../../lib/common.js";
import { h } from "../../shared/dom.js";

/** So pasted names sort in order. */
const pasteStamp = () => {
  const now = new Date();
  const two = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
};

/** Every browser names a pasted screenshot "image.png". */
const named = (file) => {
  if (file.name && !/^image\.[a-z0-9]+$/i.test(file.name)) return file;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  return new File([file], `paste-${pasteStamp()}.${extension}`, { type: file.type });
};

/** Without spaces, so a Markdown text refers to it as it is. */
const sendName = (name) => {
  const safe = safeName(name, "file");
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  const tidy = base
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${tidy || "file"}${extension}`;
};

const fileListOf = (files) => {
  const list = new DataTransfer();
  for (const file of files) list.items.add(file);
  return list.files;
};

/** `onChange` runs whenever what is held changes; `limit` is the largest a file may be. */
export const createComposerFiles = ({ status, limit, onChange }) => {
  const fileInput = element("#file");
  const fileList = element("#file-list");

  /** Copies the whole path, even where the name shows cut short, as on a phone. */
  const copyPathButton = (file) => {
    const path = `${ASSETS}${file.name}`;
    const control = h(
      "button",
      { type: "button", class: "file-name", title: "Copy its path" },
      h("span", { class: "file-folder" }, ASSETS),
      file.name,
    );
    control.addEventListener("click", async () => {
      try {
        await copyText(path);
        status.success(`Copied ${path}.`);
      } catch (error) {
        status.error(error.message);
      }
    });
    return control;
  };

  /** So a text refers to them by the names listed here. */
  const normalize = () => {
    const files = [...fileInput.files];
    const names = uniqueNames(files.map((file) => sendName(file.name)));
    if (names.every((name, index) => name === files[index].name)) return;
    fileInput.files = fileListOf(
      files.map((file, index) =>
        names[index] === file.name ? file : new File([file], names[index], { type: file.type }),
      ),
    );
  };

  // The browser's own field only says how many.
  let picked = [];
  const show = () => {
    normalize();
    picked = [...fileInput.files];
    const files = [...fileInput.files];
    fileList.hidden = files.length === 0;
    onChange();
    if (!files.length) {
      fileList.replaceChildren();
      return;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const action = (label, name, onClick) => {
      const button = h(
        "button",
        { type: "button", class: "row-action", "aria-label": name },
        label,
      );
      button.addEventListener("click", onClick);
      return button;
    };
    fileList.replaceChildren(
      ...files.map((file, index) =>
        h(
          "li",
          { class: file.size > limit() ? "too-large" : undefined },
          copyPathButton(file),
          h(
            "span",
            { class: "file-size" },
            formatBytes(file.size),
            file.size > limit() ? " · too large" : "",
            action("remove", `Remove ${file.name}`, () => remove(index)),
          ),
        ),
      ),
      h(
        "li",
        { class: "file-total" },
        h("span", {}, `Total · ${files.length === 1 ? "1 file" : `${files.length} files`}`),
        h(
          "span",
          { class: "file-size" },
          formatBytes(total),
          action("clear", "Remove every file", () => clear()),
        ),
      ),
    );
  };

  const remove = (index) => {
    fileInput.files = fileListOf([...fileInput.files].filter((_, other) => other !== index));
    show();
    // Focus stays in the list.
    fileList.querySelectorAll(".row-action")[Math.min(index, fileInput.files.length)]?.focus();
  };

  const clear = () => {
    fileInput.value = "";
    show();
  };

  // The picker and drops replace what was picked; this adds instead. The page's
  // own changes (a paste, a removal) arrive untrusted and are taken as they are.
  const sameFile = (a, b) =>
    a.size === b.size && a.lastModified === b.lastModified && sendName(a.name) === b.name;
  fileInput.addEventListener("change", (event) => {
    if (event.isTrusted && picked.length) {
      fileInput.files = fileListOf([
        ...picked,
        ...[...fileInput.files].filter((file) => !picked.some((kept) => sameFile(file, kept))),
      ]);
    }
    show();
  });

  /** Replaces what is held. */
  const set = (files) => {
    fileInput.files = fileListOf(files);
    show();
  };

  return {
    list: () => [...fileInput.files],
    count: () => fileInput.files.length,
    set,
    clear,
    show,
    /** Pasted or dropped files join the others; returns them as named here. */
    add(files) {
      set([...fileInput.files, ...files.map(named)]);
      return [...fileInput.files].slice(-files.length);
    },
  };
};
