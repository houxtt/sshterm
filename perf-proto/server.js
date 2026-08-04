// 链路压测原型: 数据源 → WebSocket → 浏览器 xterm.js 渲染
// 用法: node server.js [--rate 0.1] [--proto serial|ssh]
//   serial: 模拟 921600 波特全速 (92KB/s)
//   ssh:    模拟 SSH 高速输出 (3MB/s, 超 xterm 常规场景)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const args = process.argv.slice(2);
const rateArg = args.indexOf('--rate');
const RATE = rateArg >= 0 ? parseFloat(args[rateArg + 1]) : 0.092;  // MB/s
const PROTO = args.indexOf('--proto') >= 0 ? args[args.indexOf('--proto') + 1] : 'serial';

// ---- 模拟数据源: 编译输出风格 (带 ANSI 颜色) ----
const line = "\x1b[32mCC  main.c:123: warning: unused variable 'x'\x1b[0m\n" +
             "\x1b[33mLD  build/out.elf\x1b[0m\n" +
             "\x1b[31mERR driver/i2c.c:45: timeout\x1b[0m\n";
const CHUNK = Buffer.from(line.repeat(200));   // ~18KB/块

const server = http.createServer((req, res) => {
  if (req.url === '/') return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  if (req.url === '/xterm.js') return res.end(fs.readFileSync(
    require.resolve('@xterm/xterm/lib/xterm.js')));
  if (req.url === '/xterm.css') return res.end(fs.readFileSync(
    require.resolve('@xterm/xterm/css/xterm.css')));
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });
let totalSent = 0, t0 = Date.now();

wss.on('connection', (ws) => {
  console.log(`[${PROTO}] 客户端接入 | 模拟速率 ${RATE} MB/s`);
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const now = Date.now();
    const payload = Buffer.alloc(4 + CHUNK.length);
    payload.writeUInt32LE(now - t0, 0);      // 时间戳(相对启动 ms)
    CHUNK.copy(payload, 4);
    ws.send(payload, { binary: true });
    totalSent += CHUNK.length;
    if (now - t0 >= 8000) {                  // 8s 后结束
      clearInterval(timer);
      ws.send(Buffer.from('__DONE__'), { binary: false });
    }
  }, Math.max(1, Math.round(CHUNK.length / (RATE * 1024 * 1024) * 1000)));
  ws.on('close', () => clearInterval(timer));
});

server.listen(8787, '127.0.0.1', () => {
  console.log(`链路原型: http://127.0.0.1:8787  (${PROTO} 模式, ${RATE} MB/s)`);
});

// 结束后打印汇总
setInterval(() => {
  const dt = (Date.now() - t0) / 1000;
  if (dt >= 9 && dt < 9.5) {
    console.log(`\n8s 共发送: ${(totalSent / 1048576).toFixed(1)} MB` +
                ` (${(totalSent / dt / 1048576).toFixed(2)} MB/s 实际)`);
    process.exit(0);
  }
}, 500);
