'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { generateKeyPairSync } = require('crypto');
const { spawn } = require('child_process');
const { Server: SshServer } = require('ssh2');
const { WebSocket } = require('ws');

if (process.platform !== 'win32') {
  console.log('✅ credential restart integration skipped (non-Windows)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const APP_PORT = 8911;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-credential-restart-'));
const password = 'restart-fixture-密码-42';
const vncPassword = 'vnc-restart-fixture-密码-73';
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs1', format: 'pem' });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function getToken(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try {
      const body = await new Promise((resolve, reject) => http.get(`${BASE}/bootstrap.js`, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => res.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${res.statusCode}`)));
      }).on('error', reject));
      const match = body.match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
    await sleep(100);
  }
  throw new Error('server startup timed out');
}

function nextMessage(ws, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket response timed out')); }, timeout);
    const handler = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'host-key') {
        ws.send(JSON.stringify({ type: 'host-key-decision', id: message.id, accept: true }));
        return;
      }
      if (message.type === 'error') { cleanup(); reject(new Error(message.msg)); return; }
      if (predicate(message)) { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}

async function startApp() {
  const child = spawn(process.execPath, ['server/index.js', '--port', String(APP_PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: 'ignore',
  });
  const token = await getToken();
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { child, ws };
}

async function stopApp(app) {
  if (!app) return;
  app.ws.close();
  if (app.child.exitCode === null) app.child.kill();
  if (app.child.exitCode === null) await new Promise(resolve => app.child.once('exit', resolve));
}

async function startSshFixture() {
  const server = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'operator' && context.password === password) context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty());
      session.on('shell', acceptShell => {
        const stream = acceptShell();
        stream.write('credential restart fixture ready\r\n');
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}

(async () => {
  const sshServer = await startSshFixture();
  const sshPort = sshServer.address().port;
  let app;
  try {
    app = await startApp();
    let response = nextMessage(app.ws, m => m.type === 'session-saved');
    app.ws.send(JSON.stringify({
      type: 'save', requestId: 'remembered-session',
      session: {
        name: 'remembered', type: 'ssh', host: '127.0.0.1', port: sshPort,
        username: 'operator', auth: 'password', password, rememberPassword: true,
      },
    }));
    const sessionId = (await response).id;
    response = nextMessage(app.ws, m => m.type === 'session-saved' && m.requestId === 'remembered-vnc');
    app.ws.send(JSON.stringify({
      type: 'save', requestId: 'remembered-vnc',
      session: {
        name: 'remembered-vnc', type: 'vnc', host: '127.0.0.1', port: 5901,
        password: vncPassword, rememberPassword: true, reconnect: true,
      },
    }));
    const vncSessionId = (await response).id;
    const encrypted = fs.readFileSync(path.join(profile, '.sshterm', 'secrets.enc'), 'utf8');
    assert(!encrypted.includes(password), 'saved credential leaked as plaintext');
    assert(!encrypted.includes(vncPassword), 'saved VNC credential leaked as plaintext');

    await stopApp(app);
    app = await startApp();
    response = nextMessage(app.ws, m => m.type === 'sessions');
    app.ws.send(JSON.stringify({ type: 'list' }));
    const restoredSessions = (await response).list;
    const saved = restoredSessions.find(item => item.id === sessionId);
    assert(saved, 'remembered session did not survive restart');
    assert.strictEqual(saved.password, undefined, 'server exposed the saved password to the browser');
    const savedVnc = restoredSessions.find(item => item.id === vncSessionId);
    assert(savedVnc, 'remembered VNC session did not survive restart');
    assert.strictEqual(savedVnc.password, undefined, 'server exposed the saved VNC password in the session list');
    response = nextMessage(app.ws, m => m.type === 'vnc-credential' && m.requestId === 'restore-vnc');
    app.ws.send(JSON.stringify({ type: 'vnc-credential', requestId: 'restore-vnc', session: savedVnc }));
    assert.strictEqual((await response).password, vncPassword, 'VNC session did not recover its encrypted remembered password');

    // Old workspace snapshots may predate stable saved-session ids. A unique
    // endpoint must still recover the encrypted credential after restart.
    const legacyWorkspaceCopy = { ...saved };
    delete legacyWorkspaceCopy.id;
    response = nextMessage(app.ws, m => m.type === 'status' && m.id === 41 && m.state === 'connected');
    app.ws.send(JSON.stringify({ type: 'connect', id: 41, session: legacyWorkspaceCopy }));
    await response;
    console.log('✅ remembered credential reconnect after server restart passed');
  } finally {
    await stopApp(app);
    await new Promise(resolve => sshServer.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
