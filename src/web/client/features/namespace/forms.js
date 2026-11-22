// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { ASSETS } from "../../../../protocol/bundle.js";
import { defaultTextName } from "../../../../sdk/k.mjs";
import { element, setBusy } from "../../lib/common.js";
import { confirmAction } from "../../lib/dialog.js";
import { buildBundle, openBundle } from "./bundle-compose.js";
import { createComposerFiles } from "./composer-files.js";
import { createTextComposer } from "./composer-text.js";
import { createPageTools } from "./page-tools.js";
import { createSendSettings } from "./send-settings.js";
import { createSending } from "./sending.js";

/*
 * What the composer holds decides the send: one text is a text item, files
 * are an item each, anything else one bundle (see protocol/bundle.js).
 * This wires the composer's parts together and owns sending and editing.
 */
export const createForms = ({ status, writeHeaders, refreshUnlessLive }) => {
  const sendForm = element("#send-form");
  const sendTitle = element("#send-title");
  const sendButton = element("#send-button");
  const cancelEdit = element("#cancel-edit");
  const summary = element("#send-summary");
  let mode = null;
  let config = null;
  /** This device's push ID, from the page (lib/push.js). */
  let pushSkip = null;
  /** Keeps what a text held and was called, to save only what changed. */
  let editing = null;

  /** Encrypted files grow a little; the server's limit applies to what it receives. */
  const fileLimit = () => mode.fileLimit(config.maxFileBytes);
  const settings = createSendSettings();

  // Constructed first: the texts' tabs count the files from the start.
  const files = createComposerFiles({
    status,
    limit: fileLimit,
    onChange: () => {
      text.refreshPreview();
      text.showTabs();
      showSummary();
    },
  });
  const text = createTextComposer({
    config: () => config,
    files: files.list,
    fileCount: files.count,
    onFiles: (picked) => takeFiles(picked),
    onChange: () => showSummary(),
  });
  const sending = createSending({
    status,
    mode: () => mode,
    config: () => config,
    settings: () => ({ ...settings.values(), pushSkip }),
    fileLimit,
  });
  const pageTools = createPageTools({
    status,
    mode: () => mode,
    writeHeaders,
    refreshUnlessLive,
  });

  /** In a Markdown text, each also leaves its reference at the caret. */
  const takeFiles = (picked) => {
    const added = files.add(picked);
    const what = added.length === 1 ? added[0].name : `${added.length} files`;
    if (text.markdownShown()) {
      text.insert(
        added
          .map((file) =>
            file.type.startsWith("image/")
              ? `![](${ASSETS}${file.name})`
              : `[${file.name}](${ASSETS}${file.name})`,
          )
          .join("\n"),
      );
      status.success(`${what} added to files, and referenced in the text.`);
      return;
    }
    status.success(`${what} added to files.`);
  };

  const sendKind = () => {
    const texts = text.filled().length;
    const count = files.count();
    if (!texts && !count) return null;
    if (texts === 1 && !count) return "text";
    if (!texts) return "files";
    return "bundle";
  };
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const showSummary = () => {
    const texts = text.filled().length;
    const count = files.count();
    const kind = sendKind();
    summary.textContent = editing
      ? `Editing ${editing.entry.info.title}.`
      : kind === "bundle"
        ? `Bundle: ${[texts && plural(texts, "text"), count && plural(count, "file")].filter(Boolean).join(", ")}.`
        : kind === "files" && count > 1
          ? `${plural(count, "file")}, one item each.`
          : "";
  };

  const showEditing = () => {
    sendTitle.textContent = editing ? "Edit" : "Send";
    sendButton.textContent = editing ? "Save changes" : "Send";
    cancelEdit.hidden = !editing;
    settings.setHidden(Boolean(editing));
    text.setSingle(editing?.kind === "text");
  };

  const clearComposer = () => {
    editing = null;
    showEditing();
    files.clear();
    text.clear();
  };

  const bundleOf = (texts) =>
    buildBundle({
      texts: texts.map((tab) => ({ name: text.fileNameOf(tab), text: tab.text })),
      files: files.list(),
      limit: fileLimit(),
    });

  /** Nothing is sent until Send. */
  const takeShare = ({ title, text: shared, url, files: sharedFiles }) => {
    if (editing) clearComposer();
    const body = url && !shared.includes(url) ? [shared, url].filter(Boolean).join("\n\n") : shared;
    const tab = text.newTab();
    tab.text = body;
    if (title && body) text.rename(tab, title);
    files.set(sharedFiles);
    text.replace([tab], body || !sharedFiles.length ? 0 : "files");
    text.suggestName();
    sendForm.scrollIntoView({ block: "start" });
  };

  const edit = async (entry) => {
    text.save();
    const holding = text.filled().length > 0 || files.count() > 0;
    if (
      (editing || holding) &&
      !(await confirmAction({
        title: "Open this item in the composer?",
        subject: editing ? editing.entry.info.title : "",
        message: editing
          ? "Your changes to it are dropped."
          : "What the composer holds now is dropped.",
        confirm: "Open",
        destructive: true,
      }))
    ) {
      return;
    }
    const { item, info } = entry;
    status.progress("Opening…");
    let opened;
    try {
      if (info.isBundle) {
        const bundle = openBundle(new Uint8Array(await (await mode.loadBlob(item)).arrayBuffer()));
        opened = {
          editing: { entry, kind: "bundle" },
          tabs: bundle.texts.map((part) => text.tabOf(part.path, part.text)),
          files: bundle.files,
        };
      } else {
        const content = await mode.loadText(item);
        const tab = text.tabOf(info.title, content);
        // A text named by its start keeps following it, as the server does.
        tab.automatic = info.title === defaultTextName(content);
        opened = {
          editing: { entry, kind: "text", original: content, name: text.fileNameOf(tab) },
          tabs: [tab],
          files: [],
        };
      }
    } catch (error) {
      status.error(error.message);
      return;
    }
    editing = opened.editing;
    showEditing();
    files.set(opened.files);
    text.replace(opened.tabs);
    status.success(`Editing ${info.title}: Save changes when done.`);
    sendForm.scrollIntoView({ block: "start" });
    text.focus({ preventScroll: true });
  };
  cancelEdit.addEventListener("click", () => {
    clearComposer();
    status.success("Edit cancelled.");
  });

  /** At the version it was opened at, so a concurrent edit is never overwritten. */
  const saveEdit = async (kind) => {
    const { item } = editing.entry;
    if (editing.kind === "text") {
      if (kind !== "text") throw new Error("Nothing to save: write a text.");
      const tab = text.filled()[0];
      sending.checkTextSize(tab.text);
      const name = text.fileNameOf(tab);
      status.progress("Saving…");
      await mode.editText(item, tab.text, {
        original: editing.original,
        title: tab.automatic || name === editing.name ? null : name,
      });
      return "Saved.";
    }
    const texts = text.filled();
    if (!texts.length) throw new Error("A bundle keeps at least one text.");
    const file = await bundleOf(texts);
    status.progress("Saving…");
    await mode.editFile(item, file);
    return "Saved.";
  };

  const send = async (kind) => {
    if (kind === "text") {
      const [tab] = text.filled();
      return sending.sendText(tab.text, text.fileNameOf(tab));
    }
    if (kind === "files") return sending.sendFiles(files.list(), files.set);
    return sending.sendBundle(await bundleOf(text.filled()));
  };

  sendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    text.save();
    text.suggestName();
    const kind = sendKind();
    if (!kind) {
      status.error(
        editing ? "Nothing to save: write a text." : "Nothing to send: write a text or add files.",
      );
      return;
    }
    setBusy(sendForm, true);
    try {
      const message = editing ? await saveEdit(kind) : await send(kind);
      clearComposer();
      status.success(message);
    } catch (error) {
      status.error(error.message);
    } finally {
      setBusy(sendForm, false);
      await refreshUnlessLive();
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted && mode) files.show();
  });

  return {
    setMode(value) {
      mode = value;
      sendButton.disabled = false;
    },
    setConfig(value) {
      config = value;
    },
    setPushSkip(value) {
      pushSkip = value;
    },
    showPage() {
      pageTools.showPage();
      // A reload may keep files picked before without saying so.
      files.show();
    },
    edit,
    takeShare,
  };
};
