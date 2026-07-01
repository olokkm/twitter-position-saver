#!/bin/sh
set -e
cd "$(dirname "$0")/.."

echo "Building gear-extension/content.js from userscript..."
node scripts/build-gear-extension.mjs

rm -f twitter-position-saver-gear.zip
zip -j twitter-position-saver-gear.zip \
  gear-extension/manifest.json \
  gear-extension/content.js

echo "Created:"
echo "  twitter-position-saver-gear.zip"
