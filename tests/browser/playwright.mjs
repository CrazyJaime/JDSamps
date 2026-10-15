// Resolve the globally installed Playwright (no local node_modules in this repo).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.env.PLAYWRIGHT_ROOT || path.join(execSync('npm root -g').toString().trim(), 'playwright');
export const { chromium } = require(root);

/** Plain headless Chromium (no extension) for offline Web Audio tests. */
export function launchPlain() {
  return chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
}
