// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { normalizeSecretName, secretNameProblem } from "../../../public/k.mjs";
// The share page (src/pages/share.tsx): shows what was shared, asks where it
// goes, and opens that namespace with ?share=<id>, whose composer takes it.
import { element, formatBytes, readConfig, SITE } from "../lib/common.js";
import { forgetNamespace, recentNamespaces } from "../lib/recent.js";
import { dropShare, readShare } from "../lib/shares.js";
import { createStatus } from "../lib/status.js";
import { h } from "../shared/dom.js";

const status = createStatus(element("#status"));
const form = element("#share-form");
const target = element("#share-target");
const recentList = element("#recent");
const params = new URLSearchParams(window.location.search);
const id = params.get("id");

/** Opens a namespace's page (a URL of this site) with the share waiting for it. */
const open = (url) => {
  url.search = new URLSearchParams({ share: id }).toString();
  window.location.assign(url.href);
};

/**
 * The namespace a typed answer names: "notes", "e#secret name", or a link
 * to either on this site. Throws why not, as the home page would say it.
 */
const destination = (typed, config) => {
  const value = typed.trim();
  if (!value) throw new Error("Type a namespace, or pick one above.");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.origin !== window.location.origin) throw new Error("That link is to another site.");
    if (url.hash.startsWith("#/")) throw new Error("A read-only link cannot send.");
    return url;
  }
  const secret = /^\/?e#(.*)$/s.exec(value)?.[1];
  if (secret !== undefined) {
    const name = normalizeSecretName(secret);
    const problem = secretNameProblem(name, config.sealed.maxNameLength);
    if (problem) throw new Error(problem);
    return new URL(`${SITE}/e#${encodeURIComponent(name)}`, window.location.origin);
  }
  const namespace = value.replace(/^\//, "").toLowerCase();
  if (!new RegExp(config.namespace.pattern).test(namespace)) {
    throw new Error("Invalid name: lowercase letters, digits, - and _.");
  }
  if (config.namespace.reserved.includes(namespace)) throw new Error("Reserved name.");
  return new URL(`${SITE}/${encodeURIComponent(namespace)}`, window.location.origin);
};

const showRecent = () => {
  const recent = recentNamespaces();
  recentList.hidden = recent.length === 0;
  element("#share-target-label").textContent = recent.length ? "Or another" : "Namespace";
  recentList.replaceChildren(
    ...recent.map(({ url, title }) => {
      const pick = h("button", { type: "button", class: "file-name recent-open" }, title);
      pick.addEventListener("click", () => open(new URL(url)));
      const forget = h(
        "button",
        { type: "button", class: "row-action", "aria-label": `Forget ${title}` },
        "×",
      );
      forget.addEventListener("click", () => {
        forgetNamespace(url);
        showRecent();
      });
      return h("li", {}, pick, forget);
    }),
  );
};

/** What was shared: its text (with its link, unless the text holds it) and its files. */
const showShared = ({ title, text, url, files }) => {
  const body = url && !text.includes(url) ? [text, url].filter(Boolean).join("\n\n") : text;
  const shown = element("#shared-text");
  shown.hidden = !(title || body);
  shown.textContent = [title, body].filter(Boolean).join("\n\n");
  const list = element("#shared-files");
  list.hidden = files.length === 0;
  list.replaceChildren(
    ...files.map((file) =>
      h(
        "li",
        {},
        h("span", { class: "file-name" }, file.name),
        h("span", { class: "file-size" }, formatBytes(file.size)),
      ),
    ),
  );
  element("#shared").hidden = false;
};

try {
  const config = readConfig();
  const share = params.has("lost") ? null : await readShare(id);
  if (!share) {
    status.error(
      params.has("lost")
        ? "Kurobako was not set up in this browser yet, so that share was lost: share it again."
        : "Nothing to share here: it was opened already, or is gone. Share it again.",
    );
  } else {
    showShared(share);
    showRecent();
    form.hidden = false;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        open(destination(target.value, config));
      } catch (error) {
        status.error(error.message);
        target.focus();
      }
    });
    element("#discard").addEventListener("click", async () => {
      await dropShare(id);
      form.hidden = true;
      element("#shared").hidden = true;
      status.success("Discarded.");
    });
  }
} catch (error) {
  status.error(error.message);
}
