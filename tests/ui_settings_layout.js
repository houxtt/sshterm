'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('./puppeteer_test');

const ROOT = path.join(__dirname, '..');
const PORT = 8894;
const URL = `http://127.0.0.1:${PORT}/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-settings-ui-'));
const screenshotDir = process.argv.includes('--screenshots') ? path.join(ROOT, 'dist') : null;
let server;
let browser;

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('settings test server did not start');
}

async function inspect(page, width, height) {
  await page.setViewport({ width, height });
  await page.click('#btn-settings');
  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector('#dlg-settings');
    const mask = document.querySelector('#dlg-settings-mask');
    const body = dialog.querySelector('.settings-content');
    const actions = dialog.querySelector('.settings-actions');
    const rect = dialog.getBoundingClientRect();
    const footer = actions.getBoundingClientRect();
    return {
      visible: !mask.classList.contains('hidden'),
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      footerVisible: footer.bottom <= innerHeight && footer.top >= 0,
      scrollable: body.scrollHeight > body.clientHeight,
      controls: ['set-theme', 'set-font-family', 'set-font-size', 'set-scrollback', 'set-cursor-blink',
        'hotkey-editor', 'btn-settings-reset', 'settings-cancel', 'btn-settings-apply']
        .every(id => !!document.getElementById(id)),
    };
  });
  assert(metrics.visible && metrics.controls, 'settings fields did not open');
  assert(metrics.rect.left >= 0 && metrics.rect.right <= width, 'settings dialog overflows horizontally');
  assert(metrics.rect.top >= 0 && metrics.rect.bottom <= height, 'settings dialog overflows vertically');
  assert(metrics.footerVisible, 'settings actions are not visible');
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, `settings-${width}x${height}.png`) });
  }
  await page.click('#settings-cancel');
  assert(await page.$eval('#dlg-settings-mask', el => el.classList.contains('hidden')),
    'cancel should close settings');
  return metrics;
}

(async () => {
  server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT, env: { ...process.env, USERPROFILE: profile, HOME: profile }, stdio: 'ignore',
  });
  await waitForServer();
  browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const desktop = await inspect(page, 1280, 800);
  const compact = await inspect(page, 390, 700);

  await page.click('#btn-settings');
  await page.select('#set-theme', 'one-dark');
  await page.click('#btn-settings-apply');
  assert.strictEqual(await page.evaluate(() => loadTerminalSettings().themeId), 'one-dark');
  await page.click('#btn-settings');
  await page.click('#btn-settings-reset');
  assert.strictEqual(await page.$eval('#set-theme', el => el.value), 'tokyo-night');
  assert.strictEqual(await page.evaluate(() => loadTerminalSettings().themeId), 'one-dark',
    'reset should not save until Apply is clicked');
  await page.click('#settings-cancel');
  assert.strictEqual(await page.evaluate(() => loadTerminalSettings().themeId), 'one-dark');
  await page.click('#btn-settings');
  await page.focus('#hotkey-editor input[data-action="newConnection"]');
  await page.keyboard.press('F7');
  assert.strictEqual(await page.evaluate(() => loadHotkeys().newConnection.key), 'f7',
    'hotkey editor should still save a new shortcut');
  await page.keyboard.press('Backspace');
  assert.strictEqual(await page.evaluate(() => loadHotkeys().newConnection.key), 'n',
    'Backspace should restore the default shortcut');
  await page.click('#settings-cancel');
  assert.deepStrictEqual(errors, [], 'settings page raised JavaScript errors');
  console.log(`✅ settings layout and controls passed (desktop scroll=${desktop.scrollable}, compact scroll=${compact.scrollable})`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  fs.rmSync(profile, { recursive: true, force: true });
});
