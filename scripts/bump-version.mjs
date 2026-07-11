import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const userscriptPath = path.join(root, 'twitter-position-saver.user.js');
const manifestPath = path.join(root, 'gear-extension', 'manifest.json');

function readUserscriptVersion(src) {
  const match = src.match(/\/\/\s*@version\s+(\d+(?:\.\d+)+)/);
  if (!match) throw new Error('No @version found in userscript');
  return match[1];
}

function bumpVersion(version) {
  const parts = version.split('.').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Invalid version: ${version}`);
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function writeVersion(version) {
  let src = fs.readFileSync(userscriptPath, 'utf8');
  if (!/\/\/\s*@version\s+\d+(?:\.\d+)+/.test(src)) {
    throw new Error('No @version found in userscript');
  }
  src = src.replace(/\/\/\s*@version\s+\d+(?:\.\d+)+/, `// @version      ${version}`);
  fs.writeFileSync(userscriptPath, src);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const args = process.argv.slice(2);
const shouldBump = args.includes('--bump');
const setIdx = args.indexOf('--set');
const setVersion = setIdx >= 0 ? args[setIdx + 1] : null;

const current = readUserscriptVersion(fs.readFileSync(userscriptPath, 'utf8'));
let next = current;

if (setVersion) {
  next = setVersion;
  writeVersion(next);
} else if (shouldBump) {
  next = bumpVersion(current);
  writeVersion(next);
} else {
  // Sync manifest to userscript version without bumping.
  writeVersion(current);
}

process.stdout.write(`${next}\n`);
