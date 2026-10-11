#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# Derives the site icons from assets/icon.png: Koma in a box, drawn pixel by
# pixel on 16×16 in the site's accent, on a transparent background. It is not
# published itself. Every size is a whole multiple of it, scaled without
# smoothing, so the pixels stay sharp. Needs ImageMagick 7 (`magick`).
#   public/favicon.ico          browser tabs: 16, 32, 48 and 64 px on a dark
#                               square, so it shows on light and dark tabs
#   public/apple-touch-icon.png iOS home screen: 180 px, opaque, with a margin
#                               for the rounded corners iOS draws
#   public/logo.png             beside the site name: 128 px, transparent; the
#                               styles paint it in each theme's accent
#   public/icon-192.png         the installed app (manifest.webmanifest): 192
#   public/icon-512.png         and 512 px, opaque, with a margin
#   public/icon-maskable.png    512 px for Android's shaped icons: the drawing
#                               within the central circle a mask always keeps
set -eu
cd "$(dirname "$0")/../public"
source=../assets/icon.png
background="#121211" # the site's dark background (--bg)

# The drawing at `size` px (a multiple of 16), on the dark square.
tile() {
  magick "$source" -filter point -resize "$1x$1" -background "$background" -flatten "$2"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for size in 16 32 48 64; do tile "$size" "$tmp/$size.png"; done
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$tmp/64.png" favicon.ico
magick "$source" -filter point -resize 128x128 -strip -define png:compression-level=9 logo.png
# The drawing at `size` px, centered on an opaque `canvas`-px square.
framed() {
  magick "$source" -filter point -resize "$1x$1" -background "$background" -gravity center \
    -extent "$2x$2" -alpha remove -alpha off -strip -define png:compression-level=9 "$3"
}
framed 160 180 apple-touch-icon.png
framed 160 192 icon-192.png
framed 448 512 icon-512.png
# 288 px: its corners stay inside the 80% circle (410 px across) every mask keeps.
framed 288 512 icon-maskable.png
echo "Wrote public/favicon.ico, apple-touch-icon.png, logo.png and the app's icons."
