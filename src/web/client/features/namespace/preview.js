// SPDX-License-Identifier: AGPL-3.0-or-later
import { ASSETS } from "../../../../protocol/bundle.js";
import { imageAddress, objectAddress, SVG_TYPE } from "../../lib/addresses.js";
import { renderMarkdown } from "../../lib/markdown.js";

export const createComposerPreview = ({ target, source, files, isVisible }) => {
  let previewUrls = [];
  /** Read once each: data: addresses (see addresses.js). */
  const svgUrls = new WeakMap();
  const svgUrlOf = (file) => {
    if (!svgUrls.has(file)) {
      svgUrls.set(file, null);
      void imageAddress(file).then((url) => {
        svgUrls.set(file, url);
        if (isVisible()) showPreview();
      });
    }
    return svgUrls.get(file);
  };
  const showPreview = () => {
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
    const byName = new Map(files().map((file) => [file.name, file]));
    target.replaceChildren(
      renderMarkdown(source(), {
        resolve: (path) => {
          // As the bundle will hold them, under assets/; a bare name finds them too.
          const file = byName.get(path.startsWith(ASSETS) ? path.slice(ASSETS.length) : path);
          if (!file) return null;
          if (file.type === SVG_TYPE) {
            const url = svgUrlOf(file);
            return url && { url, type: file.type, name: file.name };
          }
          const url = objectAddress(file);
          previewUrls.push(url);
          return { url, type: file.type, name: file.name };
        },
      }),
    );
  };
  return {
    render: showPreview,
    dispose() {
      for (const url of previewUrls) URL.revokeObjectURL(url);
      previewUrls = [];
    },
  };
};
