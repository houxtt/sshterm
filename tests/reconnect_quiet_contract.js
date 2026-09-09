// 重连失败不得刷屏终端; 自动重连用尽后 Ctrl+R 主动重连且不能触发浏览器刷新。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

assert(app.includes('shouldQuietReconnectError('), 'reconnect errors must be filtered before terminal writeln');
assert(app.includes('handleReconnectHotkey('), 'Ctrl+R must be routed through a reconnect hotkey handler');
assert(app.includes("k === 'r'"), 'Ctrl+R must be captured');
assert(app.includes('MANUAL_RECONNECT_HINT'), 'exhausted auto-reconnect must tell the user to press Ctrl+R');
assert(app.includes('autoReconnectExhausted'), 'auto-reconnect exhaustion must be sticky until a successful connect');
assert(app.includes('preventDefault()'), 'Ctrl+R capture must prevent a browser reload');

const from = app.indexOf('function shouldQuietReconnectError');
const to = app.indexOf('function startSessionConnect');
assert(from >= 0 && to > from, 'reconnect policy helpers must be adjacent and extractable');

const tabs = { includes: () => true };
const ctx = { tabs };
vm.runInNewContext(`${app.slice(from, to)}\nthis.shouldQuietReconnectError = shouldQuietReconnectError;\nthis.shouldCaptureReconnectHotkey = shouldCaptureReconnectHotkey;`, ctx);

const connected = { everConnected: true, intentionalClose: false, cfg: { reconnect: true }, state: 'closed' };
assert.strictEqual(ctx.shouldQuietReconnectError(connected, { msg: 'SSH 连接失败: connect ETIMEDOUT' }), true,
  'live sessions must not print auto-reconnect failures into the terminal');
assert.strictEqual(ctx.shouldQuietReconnectError(connected, { action: 'sftp', msg: 'SFTP: boom' }), false,
  'SFTP/action errors must still be shown');
assert.strictEqual(ctx.shouldQuietReconnectError({ ...connected, everConnected: false }, { msg: 'SSH 连接失败' }), false,
  'first-connect failures must still be shown');
assert.strictEqual(ctx.shouldQuietReconnectError({ ...connected, intentionalClose: true }, { msg: 'SSH 连接失败' }), false,
  'user-closed sessions must not swallow errors');

assert.strictEqual(ctx.shouldCaptureReconnectHotkey({ ...connected, autoReconnectExhausted: true }), true,
  'Ctrl+R must be captured after auto-reconnect gives up');
assert.strictEqual(ctx.shouldCaptureReconnectHotkey({ ...connected, state: 'connected', autoReconnectExhausted: true }), false,
  'Ctrl+R must reach the remote shell while connected');
assert.strictEqual(ctx.shouldCaptureReconnectHotkey({ ...connected, everConnected: false, autoReconnectExhausted: true }), false,
  'Ctrl+R reconnect is only for sessions that had a live connection');

console.log('✅ reconnect quiet / Ctrl+R contract passed');
