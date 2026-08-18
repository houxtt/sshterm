// HTTP transport integration for Range download and upload resource limits.
// Uses the explicitly enabled local SFTP fixture; no SSH server is required.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8902;
const BASE = `http://127.0.0.1:${PORT}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-sftp-'));
const profile = path.join(temp, 'profile');
const fixture = path.join(temp, 'remote');
let clientToken = '';
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, 'range.txt'), '0123456789');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForServer(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try { await new Promise((resolve, reject) => http.get(BASE, res => { res.resume(); res.statusCode === 200 ? resolve() : reject(); }).on('error', reject)); return; }
    catch { await sleep(100); }
  }
  throw new Error('server startup timed out');
}
async function loadToken() {
  const script = await new Promise((resolve, reject) => http.get(`${BASE}/bootstrap.js`, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
    res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`bootstrap HTTP ${res.statusCode}`)));
  }).on('error', reject));
  const match = script.match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('bootstrap token not found');
  clientToken = match[1];
}
function request(method, target, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const join = target.includes('?') ? '&' : '?';
    const req = http.request(`${BASE}${target}${join}token=${encodeURIComponent(clientToken)}`, { method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}
function pendingUpload(name) {
  const req = http.request(`${BASE}/api/sftp/upload?conn=9900&path=.&name=${encodeURIComponent(name)}&token=${encodeURIComponent(clientToken)}`, {
    method: 'PUT', headers: { 'Content-Length': '2' },
  });
  const done = new Promise((resolve, reject) => {
    req.on('response', res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) })); });
    req.on('error', reject);
  });
  req.write('x'); // deliberately keep one byte outstanding to occupy one slot
  return { req, done };
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile, SSHTERM_TEST_SFTP_ROOT: fixture },
    stdio: 'ignore',
  });
  try {
    await waitForServer();
    await loadToken();
    const partial = await request('GET', '/api/sftp/download?conn=9900&path=range.txt', { Range: 'bytes=3-6' });
    assert.strictEqual(partial.status, 206, 'Range request status');
    assert.strictEqual(partial.headers['content-range'], 'bytes 3-6/10', 'Range header');
    assert.strictEqual(partial.body.toString(), '3456', 'Range response body');
    const invalid = await request('GET', '/api/sftp/download?conn=9900&path=range.txt', { Range: 'bytes=20-' });
    assert.strictEqual(invalid.status, 416, 'invalid Range rejected');

    const first = pendingUpload('same.bin');
    await sleep(100);
    const duplicate = await request('PUT', '/api/sftp/upload?conn=9900&path=.&name=same.bin', { 'Content-Length': '1' }, 'y');
    assert.strictEqual(duplicate.status, 409, 'same remote target must be exclusive');
    const second = pendingUpload('two.bin');
    const third = pendingUpload('three.bin');
    await sleep(100);
    const saturated = await request('PUT', '/api/sftp/upload?conn=9900&path=.&name=four.bin', { 'Content-Length': '1' }, 'z');
    assert.strictEqual(saturated.status, 429, 'global upload concurrency cap');
    [first, second, third].forEach(upload => upload.req.end('y'));
    const completed = await Promise.all([first.done, second.done, third.done]);
    assert(completed.every(result => result.status === 200), 'reserved uploads must complete');
    assert.strictEqual(fs.readFileSync(path.join(fixture, 'same.bin'), 'utf8'), 'xy', 'upload result content');
    console.log('✅ SFTP range and upload resource integration passed');
  } finally {
    server.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
