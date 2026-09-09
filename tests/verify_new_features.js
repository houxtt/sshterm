const assert = require('assert');
const path = require('path');

// 1) DPAPI module should load and expose writeSecrets/readSecrets
const dpapi = require('../server/dpapi');
assert(typeof dpapi.writeSecrets === 'function', 'writeSecrets missing');
assert(typeof dpapi.readSecrets === 'function', 'readSecrets missing');

// 2) SSHConnection exports class and tunnel API shape
const SSHConnection = require('../server/connections/ssh');
assert.strictEqual(typeof SSHConnection, 'function', 'SSHConnection should be constructor');
const conn = new SSHConnection({
  type: 'ssh', host: '127.0.0.1', port: 22, user: 'u', password: 'p'
});
assert.strictEqual(typeof conn.listTunnels, 'function', 'listTunnels method missing');
assert.strictEqual(typeof conn.addTunnel, 'function', 'addTunnel method missing');
assert.strictEqual(typeof conn.removeTunnel, 'function', 'removeTunnel method missing');
assert.deepStrictEqual(conn.listTunnels(), [], 'initial tunnels');

// 3) Server index.js handles tunnel WS case
const root = path.join(__dirname, '..');
const fs = require('fs');

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

const src = readServerSources();
assert(src.includes("case 'tunnel':"), 'server tunnel case exists');

console.log('✅ DPAPI + SSH tunnel new-feature verification passed');
