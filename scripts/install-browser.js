'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, [path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium', '--no-shell'], { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.resolve(__dirname, '../browsers') } });
process.exit(result.status ?? 1);
