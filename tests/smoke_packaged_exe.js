// Validates a locally built caxa artifact as a whole product, not just its
// static page: launcher identity, origin/token gate, SFTP HTTP routing,
// DPAPI-backed credential persistence across a restart, native serialport
// enumeration and the VNC bridge upgrade path.  Everything runs against an
// isolated USERPROFILE so the developer's real sessions are never touched.
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'sshterm.exe');
const PORT = Number(process.env.SSHTERM_SMOKE_PORT || 8903);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(EXE)) throw new Error('dist/sshterm.exe 不存在；请先运行 node scripts/build-exe.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function waitForApp(deadline = Date.now() + 30000) {
  while (Date.now() < deadline) {
    try {
      const res = await httpGet('/launcher-info');
      if (res.status === 200) return JSON.parse(res.body);
    } catch { /* not listening yet */ }
    await sleep(150);
  }
  throw new Error('packaged EXE did not start listening');
}

async function readToken() {
  const res = await httpGet('/bootstrap.js', { Origin: ORIGIN, Referer: `${ORIGIN}/` });
  assert.strictEqual(res.status, 200, 'bootstrap.js must be served to a trusted origin');
  const match = res.body.match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
  assert(match, 'bootstrap token missing from packaged response');
  return match[1];
}

function nextMessage(ws, predicate, timeout = 15000, label = 'message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out`)); }, timeout);
    const handler = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'error') { cleanup(); reject(new Error(`${label}: ${message.msg}`)); return; }
      if (predicate(message)) { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}

async function openWs(pathname, token) {
  const sep = pathname.includes('?') ? '&' : '?';
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}${sep}token=${encodeURIComponent(token)}`, {
    headers: { Origin: ORIGIN },
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

// The bridge may close before an `open`-then-listen sequence would attach its
// close handler, so listen first and treat an early close as the result.
function expectWsClose(pathname, token, timeout = 15000) {
  const sep = pathname.includes('?') ? '&' : '?';
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}${sep}token=${encodeURIComponent(token)}`, {
    headers: { Origin: ORIGIN },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('VNC bridge did not close')); }, timeout);
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason || '') }); });
    ws.once('error', () => { /* close follows */ });
  });
}

async function startApp(profile) {
  // SSHTERM_SMOKE_SOURCE=1 runs the same flow against `node server/index.js`
  // instead of the packaged EXE.  That debugs the assertions without a rebuild,
  // but it does NOT validate packaging (bundled node_modules / native modules),
  // so it must never replace the EXE run before a release.
  const sourceMode = process.env.SSHTERM_SMOKE_SOURCE === '1';
  const cmd = sourceMode ? process.execPath : EXE;
  const args = sourceMode
    ? ['server/index.js', '--port', String(PORT), '--no-open']
    : ['--port', String(PORT), '--no-open'];
  if (sourceMode) console.log('   (source mode: packaged artifact NOT validated)');
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: 'ignore',
  });
  const info = await waitForApp();
  assert.strictEqual(info.app, 'sshterm', 'packaged launcher-info must identify sshterm');
  assert.ok(Number.isInteger(info.pid), 'launcher-info must expose the real PID');
  const token = await readToken();
  const ws = await openWs('/', token);
  return { child, ws, token, info };
}

async function stopApp(app) {
  if (!app) return;
  try { app.ws.close(); } catch { /* already gone */ }
  // The caxa launcher spawns an inner node process; killing only the parent
  // leaves it alive holding the port.  Kill the whole process tree instead.
  if (app.child.exitCode === null) {
    if (process.platform === 'win32') {
      try {
        require('child_process').execSync(`taskkill /PID ${app.child.pid} /T /F`, { stdio: 'ignore' });
      } catch { /* already exited */ }
    } else {
      app.child.kill();
    }
  }
  if (app.child.exitCode === null) await new Promise((resolve) => app.child.once('exit', resolve));
  // Give the port a moment to be released before the restart phase reuses it.
  await sleep(300);
}
const checks = [];
function record(name) { checks.push(name); console.log(`   ✓ ${name}`); }

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-exe-smoke-'));
  let app = null;
  const sessionId = { value: '' };

  try {
    app = await startApp(profile);
    record('launcher identity + bootstrap token (isolated profile)');

    // ---------- static assets ----------
    const ui = await httpGet('/', { Origin: ORIGIN });
    assert.strictEqual(ui.status, 200, 'UI index must be served');
    assert(ui.body.includes('sshterm'), 'UI page must identify the product');
    const vendor = await httpGet('/vendor/@xterm/xterm/lib/xterm.js', { Origin: ORIGIN });
    assert.strictEqual(vendor.status, 200, 'bundled xterm asset must be served from the package');
    record('web assets + bundled node_modules served');

    // ---------- security gate ----------
    const foreign = await httpGet('/bootstrap.js', { Origin: 'http://evil.example' });
    assert.strictEqual(foreign.status, 403, 'untrusted origin must not receive the token');
    const noToken = await httpGet('/api/sftp/download?conn=1&path=/tmp/x', { Origin: ORIGIN });
    assert.strictEqual(noToken.status, 403, 'API without token must be rejected');
    record('origin/token gate enforced inside the packaged build');

    // ---------- SFTP HTTP routing (module graph loaded) ----------
    const sftp = await httpGet(`/api/sftp/download?conn=1&path=/tmp/x&token=${encodeURIComponent(app.token)}`, { Origin: ORIGIN });
    assert.strictEqual(sftp.status, 400, 'SFTP route must answer without a live connection');
    assert(sftp.body.includes('SFTP'), `SFTP handler answered unexpectedly: ${sftp.body}`);
    record('SFTP HTTP handler + ssh2/archiver module graph loaded');

    // ---------- sessions over WS ----------
    let response = nextMessage(app.ws, (m) => m.type === 'sessions', 15000, 'session list');
    app.ws.send(JSON.stringify({ type: 'list' }));
    assert(Array.isArray((await response).list), 'session list must be an array');
    record('WebSocket JSON routing + sessions store');

    // ---------- native serialport binding ----------
    response = nextMessage(app.ws, (m) => m.type === 'serialports', 20000, 'serialport enumeration');
    app.ws.send(JSON.stringify({ type: 'serialports' }));
    const ports = (await response).list;
    assert(Array.isArray(ports), 'serialport enumeration must return a list');
    record(`native serialport binding works (${ports.length} port(s) detected)`);

    // ---------- VNC bridge policy ----------
    // A public target must be refused by the bridge's private-target policy,
    // which proves the VNC module and its validation ran inside the package.
    const vncClose = await expectWsClose('/vnc?host=8.8.8.8&port=5901', app.token);
    assert.strictEqual(vncClose.code, 1008, `VNC bridge must enforce its policy, got ${vncClose.code}`);
    assert(vncClose.reason.includes('私网'), `unexpected VNC close reason: ${vncClose.reason}`);
    record('VNC bridge upgrade path + private-target policy');

    // ---------- DPAPI write ----------
    const vncPassword = `exe-smoke-vnc-密码-${Date.now()}`;
    response = nextMessage(app.ws, (m) => m.type === 'session-saved', 15000, 'session save');
    app.ws.send(JSON.stringify({
      type: 'save', requestId: 'exe-smoke-vnc', session: {
        name: 'exe-smoke-vnc', type: 'vnc', host: '127.0.0.1', port: 5901,
        password: vncPassword, rememberPassword: true, reconnect: true,
      },
    }));
    sessionId.value = (await response).id;
    const secretsPath = path.join(profile, '.sshterm', 'secrets.enc');
    assert(fs.existsSync(secretsPath), 'DPAPI secrets file must be written by the packaged build');
    assert(!fs.readFileSync(secretsPath, 'utf8').includes(vncPassword),
      'DPAPI-protected secrets must not contain plaintext');
    response = nextMessage(app.ws, (m) => m.type === 'sessions', 15000, 'session list');
    app.ws.send(JSON.stringify({ type: 'list' }));
    const listed = (await response).list.find((item) => item.id === sessionId.value);
    assert(listed, 'saved session must be listed');
    assert.strictEqual(listed.password, undefined, 'session list must never expose the password');
    record('DPAPI credential write + list sanitization');

    // ---------- DPAPI read after restart ----------
    await stopApp(app);
    app = await startApp(profile);
    response = nextMessage(app.ws, (m) => m.type === 'vnc-credential' && m.requestId === 'exe-smoke-restore',
      20000, 'vnc credential');
    app.ws.send(JSON.stringify({
      type: 'vnc-credential', requestId: 'exe-smoke-restore',
      session: { id: sessionId.value, type: 'vnc', host: '127.0.0.1', port: 5901 },
    }));
    assert.strictEqual((await response).password, vncPassword,
      'DPAPI must decrypt the remembered credential after a packaged restart');
    record('DPAPI credential read after packaged restart');

    console.log(`\n✅ packaged EXE full smoke test passed (${checks.length} checks)`);
  } finally {
    await stopApp(app);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error('❌', error.stack || error.message); process.exit(1); });

