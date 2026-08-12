// Security regression: session listings and on-disk sessions must not expose
// reusable credentials. The test uses a disposable session id and removes it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');

const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8799');
const name = `security-test-${Date.now()}`;
let savedId;
function fail(msg) { console.error('❌', msg); try { ws.close(); } catch (_) {} process.exit(1); }
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'save', session: {
    name, type: 'ssh', host: '127.0.0.1', port: 22, username: 'test',
    password: 'MUST_NOT_BE_WRITTEN', passphrase: 'MUST_NOT_BE_WRITTEN',
  }}));
});
ws.on('message', (raw, binary) => {
  if (binary) return;
  const m = JSON.parse(raw.toString());
  if (m.type === 'sessions' && !savedId) {
    const item = m.list.find(s => s.name === name);
    if (!item) return fail('保存后的会话未返回');
    savedId = item.id;
    for (const k of ['password', 'passphrase', 'loginPass']) {
      if (Object.prototype.hasOwnProperty.call(item, k)) return fail(`列表泄漏字段: ${k}`);
    }
    const file = path.join(os.homedir(), '.sshterm', 'sessions.json');
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('MUST_NOT_BE_WRITTEN')) return fail('sessions.json 写入了明文凭据');
    ws.send(JSON.stringify({ type: 'delete', id: savedId }));
  } else if (m.type === 'sessions' && savedId) {
    console.log('✅ 会话列表和 sessions.json 均未暴露可复用凭据');
    ws.close();
    process.exit(0);
  } else if (m.type === 'error') fail(m.msg || '服务端错误');
});
setTimeout(() => fail('超时'), 10000);