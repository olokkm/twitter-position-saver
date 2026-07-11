import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'twitter-position-saver.user.js'), 'utf8');

// Gear's in-app updater often does not follow GitHub release-asset redirects, so
// it downloads an empty body and ZIPFoundation fails with ArchiveError 13
// (missingEndOfCentralDirectoryRecord). Serve the XPI from raw.githubusercontent.com
// (HTTP 200, no redirect) instead.
const REPO_RAW = 'https://raw.githubusercontent.com/olokkm/twitter-position-saver/main';
const GECKO_ID = 'twitter-position-saver@olokkm';
const XPI_NAME = 'twitter-position-saver-gear.xpi';

const versionMatch = src.match(/\/\/\s*@version\s+(\d+(?:\.\d+)+)/);
if (!versionMatch) throw new Error('No @version found in userscript');
const version = versionMatch[1];

const manifestPath = path.join(root, 'gear-extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
manifest.content_scripts = [
  {
    matches: ['https://x.com/*', 'https://twitter.com/*'],
    js: ['content.js'],
    run_at: 'document_start',
    all_frames: false
  }
];
manifest.browser_specific_settings = {
  gecko: {
    id: GECKO_ID,
    update_url: `${REPO_RAW}/updates.json`
  }
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const updates = {
  addons: {
    [GECKO_ID]: {
      updates: [
        {
          version,
          update_link: `${REPO_RAW}/${XPI_NAME}`
        }
      ]
    }
  }
};
fs.writeFileSync(path.join(root, 'updates.json'), `${JSON.stringify(updates, null, 2)}\n`);

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

const guardPath = path.join(root, 'gear-extension', 'scroll-guard.js');
if (fs.existsSync(guardPath)) fs.unlinkSync(guardPath);
