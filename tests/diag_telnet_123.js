// 诊断 v2: 严格按提示时序交互 (等 login: → root → 等 Password: → 空密码)
const net = require('net');

const HOST = '192.168.1.123', PORT = 23;
const sock = net.connect({ host: HOST, port: PORT, timeout: 8000 });

const T = (new Date()).toLocaleTimeString('zh-CN', { hour12: false });
function ts() { return `[${(new Date()).toLocaleTimeString('zh-CN', { hour12: false })}]`; }
function show(tag, buf) {
  const ascii = buf.toString('utf8').replace(/[^\x20-\x7e]/g, '·');
  const hex = Array.from(buf).slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`${ts()} ${tag}: ${buf.length}B  ascii="${ascii.slice(0, 70)}"${buf.length > 70 ? '…' : ''}`);
  console.log(`           hex: ${hex}${buf.length > 32 ? '…' : ''}`);
}

let buf = '';
let sentUser = false, sentPass = false, done = false;

function send(s) { console.log(`${ts()} ←发送: ${JSON.stringify(s)}`); sock.write(s); }

sock.on('connect', () => console.log(`${ts()} ✓ TCP 连接成功`));
sock.on('error', (e) => { console.log(`${ts()} ✗ ${e.message}`); process.exit(1); });

sock.on('data', (d) => {
  show('收', d);
  buf += d.toString('latin1');
  const lower = buf.toLowerCase();

  if (!sentUser && lower.includes('login:')) {
    sentUser = true;
    setTimeout(() => send('root\r\n'), 100);
    return;
  }
  if (sentUser && !sentPass && /password:/.test(lower)) {
    sentPass = true;
    setTimeout(() => send('\r\n'), 100);     // 空密码
    return;
  }
  // 无 Password 提示但回到 login: → 用户名被拒
  if (sentUser && !sentPass && /login:/.test(lower)) {
    console.log(`${ts()} ⚠️ 未出现 Password: 直接回到 login: → root 被拒或无需密码流程`);
    console.log(`${ts()} 尝试直接发命令 (万一已登录): echo TELNET123_OK`);
    setTimeout(() => send('echo TELNET123_OK\r\n'), 100);
    sentPass = true; done = true;
    return;
  }
  if ((sentPass || done) && lower.includes('telnet123_ok')) {
    console.log(`\n✅ 登录成功且有回显!`);
    sock.end(); process.exit(0);
  }
});
sock.on('close', () => { console.log(`${ts()} 连接关闭`); process.exit(1); });
setTimeout(() => { console.log(`${ts()} ✗ 12 秒未完成`); process.exit(1); }, 12000);
