const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

assert(server.includes("process.env.SSHTERM_DETACHED_GRACE_MS || 0"),
  'detached cleanup must be opt-in');
assert(server.includes('if (!DETACHED_CONNECTION_GRACE_MS) return;'),
  'default WebSocket loss must not schedule remote connection cleanup');
assert(/function sendConnectionData[\s\S]*bufferConnectionHistory\(conn, data\);[\s\S]*sendBinary/.test(server),
  'every live output chunk must enter the rolling replay buffer');
assert(server.includes('resumed: true, historyReplay'),
  'reattach status must announce authoritative history replay');
assert(app.includes('if (m.resumed && m.historyReplay)'),
  'client must reset its stale transcript before server replay');
assert(app.includes('scheduleTabsSave();'), 'terminal output must schedule a browser snapshot');
assert(app.includes("window.addEventListener('pagehide', () => saveTabs());"),
  'pagehide must force a final transcript snapshot');
assert(app.includes('paneBufs:'), 'split-pane transcripts must be serialized');
assert(app.includes("replay: item.paneBufs?.[n] || ''"), 'split-pane transcripts must be restored');

console.log('✅ long-connection and transcript persistence contract passed');
