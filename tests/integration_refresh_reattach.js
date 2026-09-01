const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8895;
const BASE = `http://127.0.0.1:${PORT}`;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-refresh-'));
fs.writeFileSync(path.join(fixture, 'alive.txt'), 'same connection');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
async function getToken(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try {
      const response = await get(`${BASE}/bootstrap.js`);
      const match = response.body.toString().match(/"([A-Za-z0-9_-]+)"/);
      if (match) return match[1];
    } catch {}
    await sleep(100);
  }
  throw new Error('server startup timed out');
}
function open(token, windowId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}&window=${windowId}`);
    const handler = (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString());
      if (message.type === 'window-id') {
        ws.off('message', handler);
        resolve({ ws, windowId: message.windowId });
      }
    };
    ws.on('message', handler);
    ws.on('error', reject);
  });
}
function waitMessage(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket response timed out')); }, timeout);
    const handler = (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}
function waitBinary(ws, id, expected, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket binary response timed out')); }, timeout);
    const handler = (raw, isBinary) => {
      if (!isBinary || raw.length < 2 || raw.readUInt16LE(0) !== id) return;
      const text = raw.subarray(2).toString();
      if (!text.includes(expected)) return;
      cleanup();
      resolve(text);
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}
function close(ws) {
  return new Promise(resolve => {
    ws.once('close', resolve);
    ws.close();
  });
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, SSHTERM_TEST_SFTP_ROOT: fixture },
    stdio: 'ignore',
  });
  let firstWs, resumedWs, otherWs;
  try {
    const token = await getToken();
    const stableWindowId = 'refresh_window_' + 'a'.repeat(48);
    const first = await open(token, stableWindowId);
    firstWs = first.ws;
    assert.strictEqual(first.windowId, stableWindowId, 'server must accept the stable window capability');

    const claimed = waitMessage(firstWs, message => message.type === 'test-sftp-claimed');
    firstWs.send(JSON.stringify({ type: 'test-sftp-claim', id: 42 }));
    await claimed;
    const marker = 'REFRESH_HISTORY_MARKER';
    const liveOutput = waitBinary(firstWs, 42, marker);
    firstWs.send(JSON.stringify({ type: 'test-connection-output', id: 42, data: marker }));
    await liveOutput;
    const before = await get(`${BASE}/api/sftp/download?token=${token}&window=${stableWindowId}&conn=42&path=alive.txt`);
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.body.toString(), 'same connection');

    // Simulate Ctrl+F5: the first WebSocket disappears, then a new page uses
    // the same sessionStorage window capability and connection id.
    await close(firstWs);
    firstWs = null;
    // Regression: the old implementation destroyed every remote connection
    // when the page WebSocket stayed detached for ten seconds.
    await sleep(10500);
    const resumed = await open(token, stableWindowId);
    resumedWs = resumed.ws;
    assert.strictEqual(resumed.windowId, stableWindowId);
    const detached = await get(`${BASE}/api/sftp/download?token=${token}&window=${stableWindowId}&conn=42&path=alive.txt`);
    assert.strictEqual(detached.status, 200, 'remote connection must survive more than the former 10s cleanup window');
    const after = await get(`${BASE}/api/sftp/download?token=${token}&window=${stableWindowId}&conn=42&path=alive.txt`);
    assert.strictEqual(after.status, 200, 'detached connection must survive the refresh grace period');

    const resumedStatus = waitMessage(resumedWs, message => message.type === 'status' && message.id === 42);
    const replayedOutput = waitBinary(resumedWs, 42, marker);
    resumedWs.send(JSON.stringify({ type: 'connect', id: 42, session: { type: 'ssh' } }));
    const status = await resumedStatus;
    assert.strictEqual(status.state, 'connected');
    assert.strictEqual(status.resumed, true, 'connect must reattach instead of dialing again');
    assert.strictEqual(status.historyReplay, true, 'reattach status must announce transcript replay');
    assert((await replayedOutput).includes(marker), 'reattach must replay output emitted before the WebSocket loss');

    const otherWindowId = 'other_window_' + 'b'.repeat(50);
    const other = await open(token, otherWindowId);
    otherWs = other.ws;
    const cross = await get(`${BASE}/api/sftp/download?token=${token}&window=${otherWindowId}&conn=42&path=alive.txt`);
    assert.strictEqual(cross.status, 400, 'another browser window must not claim the refreshed connection');
    console.log('✅ refresh connection reattach integration passed');
  } finally {
    if (firstWs) firstWs.close();
    if (resumedWs) resumedWs.close();
    if (otherWs) otherWs.close();
    server.kill();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('❌', error.stack || error.message);
  process.exit(1);
});
