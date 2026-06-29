#!/bin/sh
set -e
cd "$(dirname "$0")/.."

echo "Building gear-extension/content.js from userscript..."
node scripts/build-gear-extension.mjs

zip -j twitter-position-saver-gear-debug.zip \
  gear-extension-debug/manifest.json \
  gear-extension-debug/content.js \
  gear-extension-debug/popup.html

zip -j twitter-position-saver-gear.zip \
  gear-extension/manifest.json \
  gear-extension/content.js \
  gear-extension/popup.html

echo "Created:"
echo "  twitter-position-saver-gear-debug.zip"
echo "  twitter-position-saver-gear.zip"
