// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { safeName, suggestedTextFileBase, textFileBase } from "../../../../public/k.mjs";
import {
  copyText,
  element,
  formatBytes,
  formatDuration,
  request,
  restoreForm,
  setBusy,
  storage,
} from "../../lib/common.js";
import {
  createTextEditor,
  fillLanguages,
  MAX_HIGHLIGHT_CHARACTERS,
} from "../../lib/text-editor.js";

export const createForms = ({ status, writeHeaders, refreshUnlessLive }) => {
  const textForm = element("#text-form");
  const fileForm = element("#file-form");
  const textInput = element("#text");
  const textLanguage = element("#text-language");
  const textName = element("#text-name");
  const textNameRow = element("#text-name-row");
  const textExtension = element("#text-extension");
  const fileInput = element("#file");
  const burnInput = element("#burn");
  const expiresInput = element("#expires-in");
  const sendSettings = () => ({
    burn: burnInput.checked,
    expiresIn: expiresInput.value || null,
  });
  const textLimit = element("#text-limit");
  const fileLimitLabel = element("#file-limit");
  const backupZip = element("#backup-zip");
  const backupTar = element("#backup-tar");
  const backupHint = element("#backup-hint");
  const restore = element("#restore-form");
  const expiryLabel = element("#expiry-label");
  const pageUrl = element("#page-url");
  const copyLinkButton = element("#copy-link");
  let mode = null;
  let config = null;
  const textInputNext = textInput.nextSibling;
  const textInputParent = textInput.parentNode;
  const languageKey = "kurobako-text-language";
  const savedLanguage = storage.get(languageKey) ?? "";
  fillLanguages(textLanguage, savedLanguage);
  let automaticName = true;
  let nameTimer = null;
  const suggestName = () => {
    if (automaticName) textName.value = suggestedTextFileBase(textInput.value);
  };
  const applyLanguage = () => {
    storage.set(languageKey, textLanguage.value);
    textExtension.textContent = `.${textLanguage.value || "txt"}`;
    mainTextEditor.refresh({ immediate: true });
  };
  const normalizeEnteredName = () => {
    const match = /\.([A-Za-z0-9_+-]+)$/.exec(textName.value);
    if (match) {
      const extension = match[1].toLowerCase();
      const language = extension === "txt" ? "" : extension;
      if ([...textLanguage.options].some((option) => option.value === language)) {
        textName.value = textName.value.slice(0, -match[0].length);
        if (textLanguage.value !== language) {
          textLanguage.value = language;
          applyLanguage();
        }
      }
    }
    textName.value = textFileBase(textName.value);
  };
  const selectedFileName = () => {
    normalizeEnteredName();
    return safeName(`${textName.value}.${textLanguage.value || "txt"}`, "text");
  };
  textExtension.textContent = `.${textLanguage.value || "txt"}`;
  textName.addEventListener("input", () => {
    automaticName = false;
  });
  textName.addEventListener("blur", normalizeEnteredName);
  suggestName();
  textInput.addEventListener("input", () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(suggestName, 200);
  });
  const mainTextEditor = createTextEditor(textInput, {
    title: () => (textLanguage.value ? `source.${textLanguage.value}` : ""),
  });
  textInputParent.insertBefore(mainTextEditor.editor, textInputNext);
  // The caret's line and column, with the language, below the text.
  textLanguage.parentElement.append(mainTextEditor.position);
  textLanguage.addEventListener("change", applyLanguage);
  textNameRow.hidden = burnInput.checked;
  burnInput.addEventListener("change", () => {
    textNameRow.hidden = burnInput.checked;
  });

  textForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = textInput.value;
    if (new Blob([text]).size > config.maxTextBytes) {
      status.error(`Text too large. Max ${formatBytes(config.maxTextBytes)}.`);
      return;
    }

    setBusy(textForm, true);
    status.progress("Sending…");
    try {
      const response = await mode.sendText(text, { ...sendSettings(), name: selectedFileName() });
      textInput.value = "";
      clearTimeout(nameTimer);
      automaticName = true;
      suggestName();
      mainTextEditor.refresh({ immediate: true });
      showTextSize();
      status.success(await sentMessage(response));
      await refreshUnlessLive();
    } catch (error) {
      status.error(error.message);
    } finally {
      setBusy(textForm, false);
    }
  });

  /** The same contents already in the queue move to the top instead (200, not 201). */
  const sentMessage = async (response) =>
    response.status === 200 && (await response.json()).existing
      ? "Already in the queue: moved to the top."
      : "Sent.";

  /**
   * The most files one send takes, by the server's own limits: no more than
   * the queue holds (more would push out what was just sent) nor than it takes
   * in a minute, since each file is a send. 20 if the server says neither.
   */
  const maxFiles = () => Math.min(config.maxItems ?? 20, config.sendsPerMinute ?? 20);

  /** Waits `seconds`, calling `tick(secondsLeft)` once a second. */
  const countdown = async (seconds, tick) => {
    for (let left = seconds; left > 0; left -= 1) {
      tick(left);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  fileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = [...fileInput.files];
    if (!files.length) return;
    if (files.length > maxFiles()) {
      status.error(`Too many files: up to ${maxFiles()} at once.`);
      return;
    }
    const tooLarge = files.filter((file) => file.size > fileLimit());
    if (tooLarge.length) {
      status.error(
        `Too large (max ${formatBytes(fileLimit())}): ${tooLarge.map((file) => file.name).join(", ")}.`,
      );
      return;
    }

    setBusy(fileForm, true);
    // The last picked goes first, so the queue, newest on top, lists them as
    // they were picked.
    const queue = files.toReversed();
    let sent = 0;
    let moved = 0;
    try {
      let waits = 0;
      for (let index = 0; index < queue.length; ) {
        status.progress(files.length > 1 ? `Sending ${sent + 1} of ${files.length}…` : "Sending…");
        let response;
        try {
          response = await mode.sendFile(queue[index], sendSettings());
        } catch (error) {
          // Past the sends allowed a minute: wait as the server asks, then go
          // on with the same file. Three waits in a row without a send: stop.
          if (error.status !== 429 || !error.retryAfter || waits >= 3) throw error;
          waits += 1;
          await countdown(error.retryAfter, (left) =>
            status.progress(
              `Send limit reached: going on in ${left} s${files.length > 1 ? ` · ${sent} of ${files.length} sent` : ""}`,
            ),
          );
          continue;
        }
        waits = 0;
        if (response.status === 200 && (await response.json()).existing) moved += 1;
        sent += 1;
        index += 1;
      }
      fileForm.reset();
      status.success(
        files.length === 1
          ? moved
            ? "Already in the queue: moved to the top."
            : "Sent."
          : `Sent ${files.length} files${moved ? ` (${moved} already in the queue, moved to the top)` : ""}.`,
      );
    } catch (error) {
      // Keep only what was not sent, so sending again sends the rest.
      const rest = new DataTransfer();
      for (const file of queue.slice(sent).toReversed()) rest.items.add(file);
      fileInput.files = rest.files;
      fileInput.dispatchEvent(new Event("change"));
      status.error(
        sent ? `Sent ${sent} of ${files.length}, then: ${error.message}` : error.message,
      );
    } finally {
      setBusy(fileForm, false);
      await refreshUnlessLive();
    }
  });

  // The server names the file and sends it as a download: the page stays.
  backupZip.addEventListener("click", () => window.location.assign(`${mode.basePath}/zip`));
  backupTar.addEventListener("click", () => window.location.assign(`${mode.basePath}/tar`));

  restoreForm({
    form: restore,
    input: element("#restore-file"),
    status,
    send: async (file) =>
      (
        await request(`${mode.basePath}/import`, {
          method: "POST",
          headers: writeHeaders(),
          body: file,
        })
      ).json(),
    // The live connection brings the new queue; this is for when it is down.
    done: refreshUnlessLive,
  });

  const copyLink = async () => {
    pageUrl.select();
    try {
      await copyText(mode.shareUrl);
      status.success("Link copied.");
    } catch (error) {
      status.error(error.message);
    }
  };
  pageUrl.addEventListener("click", copyLink);
  copyLinkButton.addEventListener("click", copyLink);

  /** Encrypted files grow a little; the server's limit applies to what it receives. */
  const fileLimit = () => mode.fileLimit(config.maxFileBytes);

  const showPage = () => {
    fileLimitLabel.textContent =
      maxFiles() > 1
        ? `Any files, up to ${maxFiles()} at once · max ${formatBytes(fileLimit())} each`
        : `Any file · max ${formatBytes(fileLimit())}`;
    pageUrl.value = mode.shareUrl;
    if (mode.label) {
      backupHint.textContent =
        "Every item as a zip or a tar, still encrypted. Items that delete when opened are left out.";
    }
  };

  /** Under the text: its size against the limit, red past it. */
  const encoder = new TextEncoder();
  let textSizeTimer = null;
  const showTextSize = () => {
    clearTimeout(textSizeTimer);
    textSizeTimer = null;
    const text = textInput.value;
    const bytes = encoder.encode(text).byteLength;
    const paused = text.length > MAX_HIGHLIGHT_CHARACTERS;
    textLimit.textContent = `${formatBytes(bytes)} / ${formatBytes(config.maxTextBytes)}${paused ? " · no colors" : ""}`;
    textLimit.title = `${formatBytes(bytes)} of ${formatBytes(config.maxTextBytes)}${paused ? "; too long to color" : ""}`;
    textLimit.classList.toggle("over", bytes > config.maxTextBytes);
  };
  // Counting and UTF-8 encoding a long text on every key would lag typing.
  textInput.addEventListener("input", () => {
    clearTimeout(textSizeTimer);
    textSizeTimer = setTimeout(showTextSize, 300);
  });

  const applyConfig = () => {
    textInput.maxLength = config.maxTextBytes;
    showTextSize();
    expiryLabel.textContent = config.itemTtlSeconds
      ? `Expires after ${formatDuration(config.itemTtlSeconds)}`
      : "No expiration";
    const maxSeconds = config.itemTtlSeconds || 30 * 24 * 60 * 60;
    const presets = [
      60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400, 259_200, 604_800, 2_592_000,
    ];
    const selected = expiresInput.value;
    expiresInput.replaceChildren(
      new Option(
        config.itemTtlSeconds
          ? `Instance default (${formatDuration(config.itemTtlSeconds)})`
          : "Instance default (no expiration)",
        "",
      ),
      ...presets
        .filter((seconds) => seconds <= maxSeconds)
        .map((seconds) => new Option(formatDuration(seconds), String(seconds))),
    );
    expiresInput.value =
      selected && [...expiresInput.options].some((option) => option.value === selected)
        ? selected
        : "";
  };

  return {
    setMode(value) {
      mode = value;
    },
    setConfig(value) {
      config = value;
      applyConfig();
    },
    showPage,
  };
};
