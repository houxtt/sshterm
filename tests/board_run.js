// 板端验证 v2: 单命令执行, 输出完整回显
const net = require('net');
const HOST = process.argv[2] || '192.168.1.111';
const CMD = process.argv[3] || 'echo hi';

const sock = net.connect({ host: HOST, port: 23, timeout: 10000 });
const IAC = 255, DO = 253, WONT = 252, WILL = 251;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

let buf = '', sentUser = false, shellReady = false, cmdSent = false, done = false;

sock.on('connect', () => {
  sock.write(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA, IAC, DO, OPT_NAWS]));
  sock.setKeepAlive(true, 30000);
});
sock.on('error', (e) => { console.error('ERR:', e.message); process.exit(1); });
sock.on('data', (d) => {
  buf += d.toString('latin1');
  const lower = buf.toLowerCase();
  if (!sentUser && lower.includes('login:')) {
    sentUser = true; setTimeout(() => send('root\r\n'), 200); return;
  }
  if (sentUser && !shellReady && /#\s*$/.test(buf)) {
    shellReady = true;
    setTimeout(() => send(CMD + '\r\n'), 300);
    cmdSent = true;
    // 输出采集: 默认 4s 后结束; 可用 WAIT_MS 环境变量延长 (长拷贝/合并用)
    const waitMs = parseInt(process.env.WAIT_MS || '4000', 10);
    setTimeout(() => { done = true; finish(); }, waitMs);
    return;
  }
});
function send(s) { sock.write(s); }
function finish() {
  const idx = buf.indexOf(CMD);
  const out = idx >= 0 ? buf.substring(idx + CMD.length) : buf;
  console.log(out.replace(/[^\x20-\x7e\r\n]/g, '').trim());
  sock.end(); process.exit(0);
}
sock.on('close', () => { if (!done) { console.error('\n连接关闭(未完成)'); process.exit(1); } });
// 总超时: 默认 20s; 与 WAIT_MS 联动 (等待时长 + 20s 余量)
setTimeout(() => { if (!done) { console.error('\n超时'); process.exit(1); } }, (parseInt(process.env.WAIT_MS || '4000', 10)) + 20000);
