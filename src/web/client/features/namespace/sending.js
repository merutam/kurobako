// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// How the composer's contents go to the server: a text, files one by one
// (waiting out the send limit), or a bundle.
import { formatBytes } from "../../lib/common.js";
import { maxFilesAtOnce } from "../../shared/limits.js";

const encoder = new TextEncoder();
const MOVED = "Already in the queue: moved to the top.";

const countdown = async (seconds, tick) => {
  for (let left = seconds; left > 0; left -= 1) {
    tick(left);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

export const createSending = ({ status, mode, config, settings, fileLimit }) => {
  const sentMessage = async (response) =>
    response.status === 200 && (await response.json()).existing ? MOVED : "Sent.";

  const checkTextSize = (text) => {
    if (encoder.encode(text).byteLength > config().maxTextBytes) {
      throw new Error(`Text too large. Max ${formatBytes(config().maxTextBytes)}.`);
    }
  };

  const sendText = async (text, name) => {
    checkTextSize(text);
    status.progress("Sending…");
    return sentMessage(await mode().sendText(text, { ...settings(), name }));
  };

  /**
   * Each file is a send, last picked first so the queue lists them as picked.
   * On a failure, `keepUnsent` gets the files not sent, so sending again sends the rest.
   */
  const sendFiles = async (files, keepUnsent) => {
    // More than the queue holds would push out what was just sent.
    const max = maxFilesAtOnce(config());
    if (files.length > max) throw new Error(`Too many files: up to ${max} at once.`);
    const tooLarge = files.filter((file) => file.size > fileLimit());
    if (tooLarge.length) {
      throw new Error(
        `Too large (max ${formatBytes(fileLimit())}): ${tooLarge.map((file) => file.name).join(", ")}.`,
      );
    }
    const queue = files.toReversed();
    let sent = 0;
    let moved = 0;
    try {
      let waits = 0;
      for (let index = 0; index < queue.length; ) {
        status.progress(files.length > 1 ? `Sending ${sent + 1} of ${files.length}…` : "Sending…");
        let response;
        try {
          response = await mode().sendFile(queue[index], settings());
        } catch (error) {
          // Rate limited: wait as the server asks, then go on. Three waits without a send: stop.
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
    } catch (error) {
      keepUnsent(queue.slice(sent).toReversed());
      throw new Error(
        sent ? `Sent ${sent} of ${files.length}, then: ${error.message}` : error.message,
      );
    }
    return files.length === 1
      ? moved
        ? MOVED
        : "Sent."
      : `Sent ${files.length} files${moved ? ` (${moved} already in the queue, moved to the top)` : ""}.`;
  };

  const sendBundle = async (file) => {
    status.progress("Sending…");
    return sentMessage(await mode().sendFile(file, settings()));
  };

  return { checkTextSize, sendText, sendFiles, sendBundle };
};
