#!/usr/bin/env bash
# Re-copy the browser tools into this site from their local project folders.
# Usage: ./sync.sh   (then review with `git status` and commit)
set -euo pipefail

SITE="$(cd "$(dirname "$0")" && pwd)"
IDEAS="${IDEAS_DIR:-$SITE/..}"

# Plain static apps: copy the three files across.
copy_static() { # <source folder> <site folder>
  mkdir -p "$SITE/$2"
  cp "$IDEAS/$1"/{index.html,script.js,styles.css} "$SITE/$2/" 2>/dev/null \
    || cp "$IDEAS/$1"/{index.html,app.js,styles.css} "$SITE/$2/"
  echo "synced $2"
}
copy_static TextExtractor text-extractor
copy_static Wheel wheel-game

# PhotoToPixel is a Vite app: build it for the /photo-to-pixel/ sub-path, then copy.
OUT="$(mktemp -d)"
(cd "$IDEAS/PhotoToPixel" && npx vite build --base=/photo-to-pixel/ --outDir "$OUT" --emptyOutDir >/dev/null)
rm -rf "$SITE/photo-to-pixel" && mkdir "$SITE/photo-to-pixel"
cp -R "$OUT"/. "$SITE/photo-to-pixel/"
rm -rf "$OUT"
echo "synced photo-to-pixel"
