const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ssh = fs.readFileSync(path.join(__dirname, '..', 'server', 'connections', 'ssh.js'), 'utf8');
const root = path.join(__dirname, '..');

function readServerSources() {
  const dir = path.join(root, 'server');
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.bak') && name !== 'free-serial.ps1')
    .sort();
  const nested = [];
  const connDir = path.join(dir, 'connections');
  if (fs.existsSync(connDir)) {
    for (const name of fs.readdirSync(connDir).filter((n) => n.endsWith('.js')).sort()) {
      nested.push(path.join('connections', name));
    }
  }
  return [...files, ...nested].map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8')).join('\n');
}

const server = readServerSources();
const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
for (const field of ['state', 'createdAt', 'rxBytes', 'txBytes', 'connections', 'lastError']) assert(ssh.includes(field), `tunnel metric missing: ${field}`);
assert(ssh.includes('_pipeTunnel'), 'tunnel byte accounting missing');
assert(server.includes('saved.tunnels'), 'tunnel persistence missing');
assert(server.includes('隧道恢复失败'), 'tunnel recovery alert missing');
assert(ui.includes('tunnelRefreshTimer') && ui.includes('RX:${t.rxBytes'), 'tunnel monitoring UI missing');
console.log('✅ tunnel monitoring contract passed');
