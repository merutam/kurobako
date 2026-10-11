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
magick "$source" -filter point -resize 160x160 -background "$background" -gravity center \
  -extent 180x180 -alpha remove -alpha off -strip apple-touch-icon.png
echo "Wrote public/favicon.ico, public/apple-touch-icon.png and public/logo.png."
