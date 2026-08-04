// 长连接观察: 连 192.168.1.123 telnetd, 每 15s 发一次心跳命令, 记录断开时机
const TelnetConnection = require('../server/connections/telnet');

const conn = new TelnetConnection({
  type: 'telnet', name: '观察', host: '192.168.1.123', port: 23,
  autoLogin: true, loginUser: 'root', loginPass: '',
});

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
let beat = 0;

conn.on('data', (d) => {
  const text = d.toString('utf8').replace(/[^\x20-\x7e]/g, '·');
  if (text.trim()) console.log(`[${ts()}] 收 ${d.length}B: ${text.slice(-60)}`);
});
conn.on('error', (m) => console.log(`[${ts()}] ❌ 错误: ${m}`));
conn.on('close', (r) => {
  console.log(`[${ts()}] ❌ 连接关闭: ${r} (存活 ${((Date.now()-t0)/1000).toFixed(0)}s)`);
  process.exit(1);
});

(async () => {
  await conn.connect();
  console.log(`[${ts()}] ✓ 已连接, 每 15s 发心跳...`);
  const timer = setInterval(() => {
    beat++;
    console.log(`[${ts()}] → 心跳 #${beat}: echo K${beat}`);
    conn.write(`echo K${beat}\n`);
  }, 15000);
  setTimeout(() => {
    clearInterval(timer);
    console.log(`[${ts()}] ✅ 观察完成: 180s 内未断开 (共 ${beat} 次心跳)`);
    conn.close();
    setTimeout(() => process.exit(0), 300);
  }, 180000);
})().catch(e => { console.log(`[${ts()}] ❌ 连接失败: ${e.message}`); process.exit(1); });
