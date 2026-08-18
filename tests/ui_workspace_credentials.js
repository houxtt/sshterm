// Browser-level regression: workspaces may restore connection metadata but
// must never persist reusable credentials in localStorage.
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8898;
const BASE = `http://127.0.0.1:${PORT}/`;
const EDGE = path.join(ROOT, 'vendor', 'chrome-headless-shell', 'chrome-headless-shell.exe');

function waitForServer(deadline = Date.now() + 10000) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(BASE, (res) => { res.resume(); res.statusCode === 200 ? resolve() : retry(); });
      req.on('error', retry);
      req.setTimeout(500, () => { req.destroy(); retry(); });
    };
    const retry = () => Date.now() < deadline ? setTimeout(attempt, 100) : reject(new Error('server startup timed out'));
    attempt();
  });
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], { cwd: ROOT });
  let browser;
  try {
    await waitForServer();
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    const result = await page.evaluate(() => {
      localStorage.clear();
      newTab({
        type: 'ssh', host: 'example.invalid', port: 22, username: 'operator',
        password: 'DO_NOT_STORE_PASSWORD', privateKey: 'DO_NOT_STORE_KEY_PATH',
        passphrase: 'DO_NOT_STORE_PASSPHRASE', loginPass: 'DO_NOT_STORE_LOGIN_PASS',
        proxy: { type: 'socks5', host: 'proxy.invalid', port: 1080, username: 'proxy-user', password: 'DO_NOT_STORE_PROXY_PASSWORD' },
        jumpAuth: { username: 'jump-user', auth: 'password', password: 'DO_NOT_STORE_JUMP_PASSWORD' },
      }, { connect: false });
      const raw = localStorage.getItem('sshterm.tabs') || '';
      $('f-type').value = 'ssh';
      updateDlgFields();
      $('f-remember').checked = true;
      return { raw, remembered: collectDlg().rememberPassword };
    });
    for (const secret of ['DO_NOT_STORE_PASSWORD', 'DO_NOT_STORE_KEY_PATH', 'DO_NOT_STORE_PASSPHRASE', 'DO_NOT_STORE_LOGIN_PASS', 'DO_NOT_STORE_PROXY_PASSWORD', 'DO_NOT_STORE_JUMP_PASSWORD']) {
      assert(!result.raw.includes(secret), `workspace leaked ${secret}`);
    }
    assert.strictEqual(result.remembered, true, 'remember-password UI is not wired to the session config');
    console.log('✅ workspace credential persistence regression passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch((error) => { console.error('❌', error.stack || error.message); process.exit(1); });
