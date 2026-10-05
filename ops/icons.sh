#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# Derives the site icons from assets/icon.png (square, transparent
# background), which is not published itself. Needs ImageMagick 7 (`magick`).
#   public/favicon.ico          browser tabs: 16, 32, 48 and 64 px, on a dark
#                               rounded square so it shows on light and dark tabs
#   public/apple-touch-icon.png iOS home screen: 180 px, opaque, with a margin
#                               for the rounded corners iOS draws
#   public/logo.png             beside the site name: 96 px, like the tab icon
set -eu
cd "$(dirname "$0")/../public"
source=../assets/icon.png
background="#101418" # the site's dark background

# The tab icon: the drawing on a dark rounded square.
rounded() {
  magick -size 256x256 xc:none -fill "$background" -draw "roundrectangle 0,0 255,255 48,48" \
    \( "$source" -resize 232x232 \) -gravity center -composite "$@"
}
rounded -define icon:auto-resize=64,48,32,16 favicon.ico
rounded -resize 96x96 -strip -colors 64 -define png:compression-level=9 logo.png
magick "$source" -resize 140x140 -background "$background" -gravity center -extent 180x180 \
  -alpha remove -alpha off -strip apple-touch-icon.png
echo "Wrote public/favicon.ico, public/apple-touch-icon.png and public/logo.png."
