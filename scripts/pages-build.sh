#!/bin/sh
# Assembles the GitHub Pages site into dist/pages/ (or $1). Used by
# .github/workflows/pages.yml, so the deployed site can be checked locally:
#
#   sh scripts/pages-build.sh && python3 -m http.server -d dist/pages
#
#   index.html               site/index.html
#   assets/social.png        site/assets/ (the og:image)
#   assets/icon-*.png        the app's own icons (src/web/assets)
#   assets/wordmark-*.png    docs/brand
#   assets/screenshots/      docs/screenshots
#
# 📌 The logo and screenshots are copied in, not committed twice: the README,
# the app and the site show the same files.
#
# Deterministic: the output depends only on the committed files, and it fails
# if the page references an asset that was not copied.
set -eu
cd "$(dirname "$0")/.."

out="${1:-dist/pages}"
rm -rf "$out"
mkdir -p "$out/assets/screenshots"

cp site/index.html "$out/index.html"
cp site/assets/* "$out/assets/"
cp src/web/assets/icon-64.png src/web/assets/icon-192.png "$out/assets/"
cp docs/brand/wordmark-on-dark.png docs/brand/wordmark-on-light.png "$out/assets/"
cp docs/screenshots/*.png "$out/assets/screenshots/"
# Serve files as they are (no Jekyll processing of the artifact).
: >"$out/.nojekyll"

missing=0
for ref in $(grep -oE '(src|srcset|href)="assets/[^"]+"' "$out/index.html" | sed -E 's/^[a-z]+="//; s/"$//' | sort -u); do
  if [ ! -f "$out/$ref" ]; then
    echo "pages-build: index.html references $ref, which is not in the site" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

echo "pages-build: $out"
(cd "$out" && find . -type f | LC_ALL=C sort)
