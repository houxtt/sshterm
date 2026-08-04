// 链路压测客户端: WS 端到端吞吐/延迟 + xterm.js 无头解析吞吐
const { WebSocket } = require('ws');
const { Terminal } = require('@xterm/xterm');

const URL = process.argv[2] || 'ws://127.0.0.1:8787';
const DUR = 8;

// ============ 1. WS 端到端 (传输层) ============
const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';
let bytes = 0, msgs = 0, t0 = null, maxLat = 0, totalLat = 0, done = false;

ws.on('open', () => {
  console.log(`[传输层] 连接 ${URL}`);
  t0 = Date.now();
});
ws.on('message', (data, isBinary) => {
  if (done) return;
  if (!isBinary) { if (data.toString() === '__DONE__') finish(); return; }
  const now = Date.now();
  const sentAt = new DataView(data).getUint32(0, true);
  const lat = now - (t0 + sentAt);
  maxLat = Math.max(maxLat, lat);
  totalLat += lat; msgs++;
  bytes += data.byteLength - 4;
});
function finish() {
  done = true;
  const dt = (Date.now() - t0) / 1000;
  console.log(`  ├─ 吞吐: ${(bytes / 1048576 / dt).toFixed(2)} MB/s (${(bytes / 1024 / dt).toFixed(0)} KB/s)`);
  console.log(`  ├─ 消息: ${msgs} 条 / ${dt.toFixed(1)}s, 平均延迟 ${(totalLat / msgs).toFixed(2)} ms, 最大 ${maxLat.toFixed(1)} ms`);
  ws.close();
  benchXterm();
}
ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });
setTimeout(() => { if (!done) { console.log('超时, 强制结束'); done = true; ws.close(); benchXterm(); } }, (DUR + 3) * 1000);

// ============ 2. xterm.js 无头解析吞吐 (解析层) ============
function benchXterm() {
  const term = new Terminal({ cols: 120, rows: 32 });
  const chunk = "\x1b[32mCC  main.c:123: warning: unused variable 'x'\x1b[0m\n" +
                "\x1b[33mLD  build/out.elf\x1b[0m\n" +
                "\x1b[31mERR driver/i2c.c:45: timeout\x1b[0m\n";
  const data = chunk.repeat(50000);           // ~4.5MB 纯文本
  const t1 = process.hrtime.bigint();
  term.write(data);
  const dt = Number(process.hrtime.bigint() - t1) / 1e9;
  console.log(`\n[解析层] xterm.js Terminal.write() 无头基准 (${(data.length / 1048576).toFixed(1)} MB)`);
  console.log(`  └─ 解析吞吐: ${(data.length / 1048576 / dt).toFixed(1)} MB/s (${(data.length / 1024 / dt).toFixed(0)} KB/s)`);
  console.log(`     (浏览器 Canvas 渲染另计, xterm 官方基准: 数十万行/秒级)`);
  process.exit(0);
}
