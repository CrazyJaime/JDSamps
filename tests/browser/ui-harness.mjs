// Opens deck.html from a static server with a fake engine/hub, for UI tests and screenshots.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE = fs.readFileSync(path.join(ROOT, 'tests/browser/pages/fake-chrome.js'), 'utf8');

export async function openUi({ state = null, hubReplies = {}, viewport = { width: 1440, height: 900 }, storage = {} } = {}) {
  const server = await startStaticServer(ROOT);
  const browser = await launchPlain();
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(FAKE);
  await page.addInitScript(([s, h, st]) => { window.__fake.state = s; Object.assign(window.__fake.hubReplies, h); Object.assign(window.__fake.storage, st); }, [state, hubReplies, storage]);
  await page.goto(`${server.origin}/deck.html`);
  return {
    page,
    errors,
    sent: () => page.evaluate(() => window.__fake.sent),
    hubCalls: () => page.evaluate(() => window.__fake.hubCalls),
    push: (msg) => page.evaluate((m) => window.__fake.push(m), msg),
    clearSent: () => page.evaluate(() => { window.__fake.sent.length = 0; }),
    async close() { await browser.close(); await server.close(); },
  };
}
