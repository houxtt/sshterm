// 诊断: 连 192.168.1.111 telnet, 先发 IAC 协商再等 login 提示
const net = require('net');

const HOST = process.argv[2] || '192.168.1.111', PORT = 23;
const sock = net.connect({ host: HOST, port: PORT, timeout: 8000 });

const IAC = 255, DO = 253, WONT = 252, WILL = 251, DONT = 254;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

function ts() { return `[${(new Date()).toLocaleTimeString('zh-CN', { hour12: false })}]`; }
function show(tag, buf) {
  const ascii = buf.toString('utf8').replace(/[^\x20-\x7e]/g, '·');
  console.log(`${ts()} ${tag}: ${buf.length}B ascii="${ascii.slice(0, 80)}"`);
}

let buf = '';
let sentUser = false, sentPass = false, done = false;
let iacSent = false;

function send(s) { console.log(`${ts()} ←发送: ${JSON.stringify(s)}`); sock.write(s); }

sock.on('connect', () => {
  console.log(`${ts()} ✓ TCP 连接成功`);
  // 先发标准客户端 IAC 协商: WILL ECHO, WILL SGA, DO SGA, DO NAWS
  const nego = Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA, IAC, DO, OPT_NAWS]);
  console.log(`${ts()} ←协商: ${Array.from(nego).map(b=>b.toString(16)).join(' ')}`);
  sock.write(nego);
  iacSent = true;
  sock.setKeepAlive(true, 30000);
});

sock.on('error', (e) => { console.log(`${ts()} ✗ ${e.message}`); process.exit(1); });

sock.on('data', (d) => {
  show('收', d);
  buf += d.toString('latin1');
  const lower = buf.toLowerCase();

  if (!sentUser && lower.includes('login:')) {
    sentUser = true;
    setTimeout(() => send('root\r\n'), 200);
    return;
  }
  if (sentUser && !sentPass && /password:/.test(lower)) {
    sentPass = true;
    setTimeout(() => send('\r\n'), 200);     // 空密码
    return;
  }
  if (sentUser && !sentPass && /login:/.test(lower)) {
    console.log(`${ts()} ⚠️ 未出现 Password 回到 login: → 尝试直接发命令`);
    setTimeout(() => send('echo TELNET111_OK\r\n'), 200);
    sentPass = true; done = true;
    return;
  }
  if ((sentPass || done) && lower.includes('telnet111_ok')) {
    console.log(`\n✅ 登录成功且有回显!`);
    sock.end(); process.exit(0);
  }
  // 直接 shell 提示符 (免密直进)
  if (iacSent && !sentUser && /(#|\$|>)\s*$/.test(lower) && buf.length > 10) {
    console.log(`${ts()} ⚠️ 直接出现 shell 提示符 (免密直进)`);
    setTimeout(() => send('echo TELNET111_OK\r\n'), 200);
    sentUser = true; sentPass = true; done = true;
  }
});

sock.on('close', () => { console.log(`${ts()} 连接关闭`); process.exit(1); });
setTimeout(() => { console.log(`${ts()} ✗ 15 秒未完成`); process.exit(1); }, 15000);
