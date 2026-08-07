// e2e 测试: 操作日志文件持久化 (每次启动新文件, 关闭后保留)
const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const LOG_DIR = path.join(os.homedir(), '.sshterm', 'logs');

// 启动前文件列表
const before = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : [];
const ws = new WebSocket(WS_URL);
ws.on('open', () => {
  console.log('[1] 请求日志列表 (logs 消息应带 file 字段)...');
  ws.send(JSON.stringify({ type: 'logs' }));
});
ws.on('message', (d, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(d.toString());
  if (m.type === 'logs') {
    console.log('[2] 日志文件:', m.file);
    const exists = m.file && fs.existsSync(m.file);
    // 文件名应带时间戳格式 sshterm-YYYYMMDD-HHMMSS.log
    const nameOk = /sshterm-\d{8}-\d{6}\.log$/.test(path.basename(m.file || ''));
    let contentOk = false;
    if (m.file && exists) {
      const content = fs.readFileSync(m.file, 'utf8');
      contentOk = content.includes('服务启动') && content.includes('[info]');
      console.log('[3] 文件内容:', JSON.stringify(content.slice(0, 80)));
    }
    const ok = exists && nameOk && contentOk;
    console.log(`\n=== ${ok ? '✅ 日志文件持久化正常 (每次启动新文件+启动首行)' : '❌'} ===`);
    ws.close();
    process.exit(ok ? 0 : 1);
  }
});
setTimeout(() => { console.log('超时'); process.exit(1); }, 10000);
