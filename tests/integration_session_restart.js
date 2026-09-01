// Regression: saved sessions must be loaded again after the launcher/server
// process restarts.  A disposable profile keeps real user data untouched.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
let port = Number(process.env.SSHTERM_TEST_PORT) || 0;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-restart-'));
const sessionDir = path.join(profile, '.sshterm');
const originalId = '11111111-1111-4111-8111-111111111111';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function getToken(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try {
      const script = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/bootstrap.js`, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`)));
      }).on('error', reject));
      const match = script.match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
    await sleep(100);
  }
  throw new Error('server startup timed out');
}

function onceMessage(ws, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket response timed out')); }, timeout);
    const handler = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'error') { cleanup(); reject(new Error(message.msg)); return; }
      if (predicate(message)) { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js', '--port', String(port), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: 'ignore',
  });
  const token = await getToken();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { child, ws };
}

async function stopServer(instance) {
  if (!instance) return;
  instance.ws.close();
  if (instance.child.exitCode !== null) return;
  instance.child.kill();
  await new Promise(resolve => instance.child.once('exit', resolve));
}

(async () => {
  if (!port) {
    port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const selected = probe.address().port;
        probe.close(error => error ? reject(error) : resolve(selected));
      });
    });
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'sessions.json'), JSON.stringify({
    [originalId]: {
      id: originalId, name: 'existing', type: 'ssh', host: 'existing.invalid',
      port: 22, username: 'operator', auth: 'password', password: 'legacy-plaintext-secret',
      rememberPassword: false,
    },
  }, null, 2));

  let instance;
  try {
    instance = await startServer();
    let response = onceMessage(instance.ws, message => message.type === 'sessions');
    instance.ws.send(JSON.stringify({ type: 'list' }));
    assert.deepStrictEqual((await response).list.map(item => item.name), ['existing'],
      'startup discarded the existing sessions file');
    for (const file of ['sessions.json', 'sessions.json.bak']) {
      assert(!fs.readFileSync(path.join(sessionDir, file), 'utf8').includes('legacy-plaintext-secret'),
        `legacy plaintext credential remained in ${file}`);
    }

    response = onceMessage(instance.ws, message => message.type === 'session-saved');
    instance.ws.send(JSON.stringify({
      type: 'save', requestId: 'save-and-connect',
      session: { name: 'new', type: 'ssh', host: 'new.invalid', port: 22,
        username: 'operator', auth: 'password', rememberPassword: false },
    }));
    const savedId = (await response).id;
    assert.match(savedId, /^[0-9a-f-]{36}$/i, 'save acknowledgement did not return the persisted id');

    await stopServer(instance);
    instance = await startServer();
    response = onceMessage(instance.ws, message => message.type === 'sessions');
    instance.ws.send(JSON.stringify({ type: 'list' }));
    const list = (await response).list;
    assert.deepStrictEqual(list.map(item => item.name).sort(), ['existing', 'new'],
      'saved sessions did not survive a server restart');
    assert(list.some(item => item.id === savedId), 'the saved session id changed after restart');
    console.log('✅ session restart persistence integration passed');
  } finally {
    await stopServer(instance);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
