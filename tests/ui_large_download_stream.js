// Browser contract: large downloads write chunks directly to the selected
// file, retain Range retry, and never require a full-file Blob.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const EDGE = require('./browser_path')(ROOT);
const PORT = 8906;
const URL = `http://127.0.0.1:${PORT}/`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-large-download-'));
const profile = path.join(temp, 'profile');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForServer(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => http.get(URL, response => {
        response.resume();
        response.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`));
      }).on('error', reject));
      return;
    } catch { await sleep(100); }
  }
  throw new Error('server startup timed out');
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer();
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof streamDownloadToFile === 'function');

    const result = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      const calls = [];
      const output = [];
      let position = 0;
      let closed = false;
      let aborted = false;
      const writable = {
        async write(value) {
          for (const byte of value) output[position++] = byte;
        },
        async seek(nextPosition) { position = nextPosition; },
        async close() { closed = true; },
        async abort() { aborted = true; },
      };
      const handle = { async createWritable() { return writable; } };
      window.fetch = async (url, options = {}) => {
        calls.push(options.headers?.Range || null);
        if (calls.length === 1) {
          let sent = false;
          const body = new ReadableStream({
            pull(controller) {
              if (sent) return;
              sent = true;
              controller.enqueue(Uint8Array.from([0, 1, 2, 3]));
              setTimeout(() => controller.error(new Error('simulated interruption')), 0);
            },
          });
          return new Response(body, { status: 200, headers: { 'Content-Length': '10' } });
        }
        return new Response(Uint8Array.from([4, 5, 6, 7, 8, 9]), {
          status: 206,
          headers: { 'Content-Length': '6', 'Content-Range': 'bytes 4-9/10' },
        });
      };
      try {
        const download = await streamDownloadToFile('/mock-large-file', Promise.resolve(handle), () => {}, 1);
        return { download, calls, output, closed, aborted };
      } finally {
        window.fetch = originalFetch;
      }
    });

    assert.deepStrictEqual(result.calls, [null, 'bytes=4-'], 'retry must continue from the written offset');
    assert.deepStrictEqual(result.output, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'disk stream byte order');
    assert.deepStrictEqual(result.download, { saved: true, size: 10, remoteIdentity: '' }, 'direct-to-disk result');
    assert.strictEqual(result.closed, true, 'successful file must be committed');
    assert.strictEqual(result.aborted, false, 'successful file must not be aborted');
    console.log('✅ large download direct-to-disk browser contract passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
