import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'twitter-position-saver.user.js'), 'utf8');

const versionMatch = src.match(/\/\/\s*@version\s+(\d+(?:\.\d+)+)/);
if (versionMatch) {
  const manifestPath = path.join(root, 'gear-extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== versionMatch[1]) {
    manifest.version = versionMatch[1];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

let body = src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n\n/, '');

const storageImpl = `const STORAGE_PREFIX = 'tps_';

    function gmGet(key) {
        try {
            const value = localStorage.getItem(STORAGE_PREFIX + key);
            return value === null ? undefined : JSON.parse(value);
        } catch {
            return undefined;
        }
    }

    function gmSet(key, value) {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }`;

body = body.replace(
    /const STORAGE_PREFIX = 'tps_';\n\n    function gmGet[\s\S]*?function gmSet[\s\S]*?\n    \}/,
    storageImpl
);

body = body.replace(/Timeline Position Saver v[\d.]+/g, 'Timeline Position Saver (Gear Web Extension)');
body = body.replace(/Timeline Saver v[\d.]+ ready/g, 'Timeline Saver ready');

fs.writeFileSync(path.join(root, 'gear-extension', 'content.js'), body);
