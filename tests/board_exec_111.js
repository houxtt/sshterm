// 板端交互工具: 连 111 telnet, 执行命令并回显结果
const net = require('net');

const HOST = process.argv[2] || '192.168.1.111', PORT = 23;
const CMD = process.argv[3] || 'uname -a';
const sock = net.connect({ host: HOST, port: PORT, timeout: 8000 });

const IAC = 255, DO = 253, WONT = 252, WILL = 251;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

let buf = '', done = false;
let sentUser = false, shellReady = false;

function send(s) { sock.write(s); }

sock.on('connect', () => {
  sock.write(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA, IAC, DO, OPT_NAWS]));
  sock.setKeepAlive(true, 30000);
});

sock.on('error', (e) => { console.error('ERR:', e.message); process.exit(1); });

sock.on('data', (d) => {
  buf += d.toString('latin1');
  const lower = buf.toLowerCase();
  if (!sentUser && lower.includes('login:')) {
    sentUser = true;
    setTimeout(() => send('root\r\n'), 200);
    return;
  }
  if (sentUser && !shellReady && /#\s*$/.test(buf)) {
    shellReady = true;
    setTimeout(() => send(CMD + '\r\n'), 200);
    return;
  }
  // 命令回显后的输出累积
  if (shellReady && done === false) {
    // 等命令回显出现后, 输出到下次提示符
    if (buf.includes(CMD) && /#\s*$/.test(buf)) {
      done = true;
      const out = buf.substring(buf.indexOf(CMD) + CMD.length).replace(/#\s*$/, '').trim();
      console.log(out);
      sock.end();
      setTimeout(() => process.exit(0), 100);
    }
  }
});

sock.on('close', () => { if (!done) process.exit(1); });
setTimeout(() => { if (!done) { console.error('TIMEOUT'); process.exit(1); } }, 15000);
