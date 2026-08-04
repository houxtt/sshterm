// 端到端测试 3: 串口 (COM27 WCH 真口: 打开/写入/关闭 + 波特率枚举)
const SerialConnection = require('../server/connections/serial');

async function tryPort(port, baud = 115200) {
  const conn = new SerialConnection({ type: 'serial', port, baudRate: baud });
  let received = Buffer.alloc(0);
  conn.on('data', (d) => { received = Buffer.concat([received, d]); });
  conn.on('error', (m) => console.log(`  [${port}@${baud}] 错误:`, m));
  try {
    await conn.connect();
    console.log(`  ✓ 打开成功 ${port} @ ${baud}`);
    conn.write(Buffer.from('AT\r\n'));          // 写入测试 (无对端时静默)
    await new Promise(r => setTimeout(r, 400));
    conn.close();
    await new Promise(r => setTimeout(r, 200));
    return true;
  } catch (e) {
    console.log(`  ✗ ${port}@${baud}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('=== 串口打开/写入/关闭测试 ===');
  console.log('(COM 被其他工具占用时 Access denied 属环境问题, 容忍)');
  const ok1 = await tryPort('COM27', 115200);
  const ok2 = await tryPort('COM27', 921600);   // 高速波特率
  const ok3 = await tryPort('COM1', 115200);    // 标准端口(可能无硬件)
  const anyOk = ok1 || ok2 || ok3;
  console.log(`\n结果: COM27@115200=${ok1} COM27@921600=${ok2} COM1=${ok3}`);
  console.log(anyOk ? '✅ 至少一个串口可用(被占用的口属环境占用)'
                    : '❌ 所有串口均不可用');
  console.log('\n(收发回环需对端设备或虚拟串口对, 见 e2e_serial_loopback 说明)');
  process.exit(anyOk ? 0 : 1);
}
main();
