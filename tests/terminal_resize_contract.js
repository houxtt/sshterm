const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SSHConnection = require('../server/connections/ssh');

const conn = new SSHConnection({
  type: 'ssh', host: 'example.invalid', port: 22, username: 'operator',
  auth: 'password', password: 'unused',
});

// Resize normally arrives while SSH authentication is still in progress.
conn.resize(237, 61);
assert.deepStrictEqual(conn._shellOptions(), {
  term: 'xterm-256color', cols: 237, rows: 61,
}, 'pre-connect resize must become the initial SSH PTY size');

let applied;
conn.stream = { setWindow(rows, cols) { applied = { rows, cols }; } };
conn.resize(181, 48);
assert.deepStrictEqual(applied, { rows: 48, cols: 181 },
  'post-connect resize must update the live SSH PTY');

conn.resize(99999, -20);
assert.deepStrictEqual(conn._ptySize, { cols: 1000, rows: 1 },
  'untrusted browser dimensions must be bounded');

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
assert(app.includes('syncTerminalSize(pane || tab, m.id)'),
  'browser must resend the fitted dimensions after the connection opens');

console.log('✅ SSH PTY resize/progress-display contract passed');
