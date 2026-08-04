// 串口诊断: 列出所有 COM + 逐个尝试打开, 报告错误类型
const { SerialPort } = require('serialport');

async function main() {
  console.log('=== 串口枚举 ===');
  const ports = await SerialPort.list();
  if (!ports.length) { console.log('未发现任何 COM 口!'); return; }
  for (const p of ports) {
    console.log(`  ${p.path} | ${p.manufacturer || '未知厂商'} | ${p.friendlyName || ''}`);
  }

  console.log('\n=== 逐个尝试打开 (2 秒超时) ===');
  for (const p of ports) {
    await new Promise((resolve) => {
      const sp = new SerialPort({ path: p.path, baudRate: 115200, autoOpen: false });
      const t = setTimeout(() => { console.log(`  ${p.path}: ⏱ 打开超时`); try{sp.close()}catch(e){}; resolve(); }, 2500);
      sp.open((err) => {
        clearTimeout(t);
        if (err) {
          const code = err.message.match(/Access denied/i) ? 'ACCESS_DENIED(被占用)' :
                       err.message.match(/cannot find|not found|does not exist/i) ? 'NOT_FOUND(设备不存在/已拔)' :
                       err.message.match(/busy/i) ? 'BUSY' : 'OTHER';
          console.log(`  ${p.path}: ✗ ${code} | ${err.message.slice(0, 90)}`);
          resolve();
        } else {
          console.log(`  ${p.path}: ✓ 打开成功`);
          setTimeout(() => { try{sp.close()}catch(e){}; resolve(); }, 500);
        }
      });
      sp.on('error', () => {});
    });
  }
  console.log('\n=== 诊断完成 ===');
}
main().catch(e => { console.error('诊断崩溃:', e.message); process.exit(1); });
