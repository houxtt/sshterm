// 板端综合验证: 部署 ota_check.sh 到 /tmp, 用环境变量注入测试路径模拟升级
// 场景: SD升级全流程(用 /tmp 模拟 A区+B区) / 版本判定 / 降级拒绝
const net = require('net');
const HOST = process.argv[2] || '192.168.1.111';

// 板端一次性执行多行脚本: 构造测试环境并跑 ota_check
const SCRIPT = [
  'cd /tmp',
  // 准备测试环境: 模拟 A区(应用) + B区(SD卡) + 升级包
  'rm -rf /tmp/ota_test && mkdir -p /tmp/ota_test/local/.ota_state /tmp/ota_test/sd/jm',
  'echo old-demo > /tmp/ota_test/local/demo_ai',
  'echo V1.0 > /tmp/ota_test/local/.ota_state/version',
  'echo IDLE > /tmp/ota_test/local/.ota_state/state',
  'mkdir -p /tmp/ota_test/pkg && echo new-demo > /tmp/ota_test/pkg/demo_ai',
  'cd /tmp/ota_test/pkg && tar czf /tmp/ota_test/sd/jm/update.tar.gz .',
  'md5sum demo_ai | awk \'{print $1}\' > /tmp/ota_test/sd/jm/update.sha256',
  'echo V2.0.0 > /tmp/ota_test/sd/jm/update.version',
  'echo "=== 测试环境就绪 ==="',
  'echo "A区版本: $(cat /tmp/ota_test/local/.ota_state/version)"',
  'echo "升级包: $(ls /tmp/ota_test/sd/jm/)"',
].join(' && ');

const sock = net.connect({ host: HOST, port: 23, timeout: 10000 });
const IAC = 255, DO = 253, WONT = 252, WILL = 251;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

let buf = '', sentUser = false, shellReady = false, sentCmd = false, done = false;
let output = '';

function send(s) { sock.write(s); }
function show(tag, b) {
  const a = b.toString('utf8').replace(/[^\x20-\x7e]/g, '·');
  process.stdout.write(`[${tag}] ${a}`);
}

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
    setTimeout(() => send(SCRIPT + '\r\n'), 200);
    return;
  }
  if (shellReady && !sentCmd && buf.includes('测试环境就绪')) {
    sentCmd = true;
    // 已经拿到环境就绪输出, 开始跑 ota_check
    const env = 'OTA_LOCAL_DIR=/tmp/ota_test/local OTA_SD_DIR=/tmp/ota_test/sd OTA_AUDIT_LOG=/tmp/ota_test/sd/audit.log OTA_AUDIT_FALLBACK=/tmp/ota_test/audit_fb.log OTA_NFS_DEBUG=0';
    setTimeout(() => send(env + ' sh /tmp/ota_check.sh\r\n'), 300);
    return;
  }
  if (sentCmd && !done && buf.includes('OTA-CHECK V3 结束')) {
    done = true;
    setTimeout(() => {
      const out = buf.substring(buf.lastIndexOf('OTA-CHECK V3 开始'));
      console.log('\n===== ota_check 输出 =====\n' + out.replace(/[^\x20-\x7e\r\n]/g, ''));
      // 验证结果
      send('cat /tmp/ota_test/local/demo_ai; echo; cat /tmp/ota_test/local/.ota_state/version; echo; cat /tmp/ota_test/local/.ota_state/state\r\n');
      setTimeout(() => {
        const tail = buf.substring(buf.length - 600);
        console.log('===== 验证输出 =====\n' + tail.replace(/[^\x20-\x7e\r\n]/g, ''));
        sock.end(); process.exit(0);
      }, 1500);
    }, 800);
  }
});
sock.on('close', () => { if (!done) { console.error('\n连接关闭(未完成)'); process.exit(1); } });
setTimeout(() => { if (!done) { console.error('\n15s 超时'); process.exit(1); } }, 30000);
