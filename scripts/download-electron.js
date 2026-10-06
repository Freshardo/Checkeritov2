'use strict';
// Bootstrap fallback for environments where the standard Electron downloader stalls.
// Always verify against the checksums shipped in the pinned Electron npm package.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function main() {
  const { version } = require('electron/package.json');
  const file = `electron-v${version}-win32-x64.zip`;
  const checksums = require('../node_modules/electron/checksums.json');
  const expected = checksums[file];
  if (!expected) throw new Error('Official checksum missing');
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${version}/${file}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error('Electron SHA-256 mismatch');
  await fs.mkdir(path.resolve('.cache'), { recursive: true });
  await fs.writeFile(path.resolve('.cache/electron.zip'), bytes);
  console.log(`Verified Electron ${version}: ${actual}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
