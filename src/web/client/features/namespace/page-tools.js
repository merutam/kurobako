// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The namespace page's own tools: backup, restore and its link.
import { copyText, element, request, restoreForm } from "../../lib/common.js";

export const createPageTools = ({ status, mode, writeHeaders, refreshUnlessLive }) => {
  const pageUrl = element("#page-url");

  element("#backup-zip").addEventListener("click", () =>
    window.location.assign(`${mode().basePath}/zip`),
  );
  element("#backup-tar").addEventListener("click", () =>
    window.location.assign(`${mode().basePath}/tar`),
  );

  restoreForm({
    form: element("#restore-form"),
    input: element("#restore-file"),
    status,
    send: async (file) =>
      (
        await request(`${mode().basePath}/import`, {
          method: "POST",
          headers: writeHeaders(),
          body: file,
        })
      ).json(),
    // For when the live connection is down.
    done: refreshUnlessLive,
  });

  const copyLink = async () => {
    pageUrl.select();
    try {
      await copyText(mode().shareUrl);
      status.success("Link copied.");
    } catch (error) {
      status.error(error.message);
    }
  };
  pageUrl.addEventListener("click", copyLink);
  element("#copy-link").addEventListener("click", copyLink);

  return {
    /** Only an encrypted page's address is known in the browser alone. */
    showPage() {
      pageUrl.value = mode().shareUrl;
    },
  };
};
