// 测试编排: 起临时服务端 → 跑全部 e2e → 汇总 → 清理
// 用法: node tests/run_all.js   (或 npm test)
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8799;

const tests = [
  { name: 'Telnet (mock: IAC+自动登录)', cmd: 'node', args: ['tests/e2e_telnet.js'] },
  { name: '串口 (COM27/COM1 打开写入)', cmd: 'node', args: ['tests/e2e_serial.js'] },
  { name: 'UI 功能 (新建→连接→shell→保存)', cmd: 'node', args: ['tests/ui_connect.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 关闭确认 (取消/确认/断开)', cmd: 'node', args: ['tests/ui_close_confirm.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 新功能 (日志/批量删除/复制)', cmd: 'node', args: ['tests/ui_features.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 卡死回归 (左键选择+右键)', cmd: 'node', args: ['tests/ui_clipboard_regression.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'SSH 重连 (保存会话双击重连)', cmd: 'node', args: ['tests/e2e_reconnect.js', `ws://127.0.0.1:${PORT}`] },
  { name: 'WS 全链路 (SSH 真实连接)', cmd: 'node', args: ['tests/e2e_ws_chain.js', `ws://127.0.0.1:${PORT}`] },
  { name: 'SFTP 文件浏览+下载', cmd: 'node', args: ['tests/e2e_sftp.js', `ws://127.0.0.1:${PORT}`] },
  { name: 'SFTP 文件上传', cmd: 'node', args: ['tests/e2e_sftp_upload.js', `ws://127.0.0.1:${PORT}`] },
  { name: 'SFTP 目录打包下载', cmd: 'node', args: ['tests/e2e_sftp_dir.js', `ws://127.0.0.1:${PORT}`] },
  { name: 'UI SFTP 面板 (连点防错)', cmd: 'node', args: ['tests/ui_sftp.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 刷新 (会话保留)', cmd: 'node', args: ['tests/ui_refresh.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 全部断开+清理', cmd: 'node', args: ['tests/ui_killall.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 刷新恢复会话', cmd: 'node', args: ['tests/ui_restore.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 文件按钮+定位当前目录', cmd: 'node', args: ['tests/ui_sftp_btn.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 同IP多会话', cmd: 'node', args: ['tests/ui_multi_conn.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 连续点击防卡死', cmd: 'node', args: ['tests/ui_dblclick.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 会话列表选择不复制', cmd: 'node', args: ['tests/ui_sidebar.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'UI 鼠标乱点不卡死', cmd: 'node', args: ['tests/ui_mouse_mash.js', `http://127.0.0.1:${PORT}/`] },
  { name: 'SSH 真实连接层 (192.168.1.216)', cmd: 'node', args: ['tests/e2e_ssh.js'] },
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: path.join(__dirname, '..'), ...opts });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d; process.stdout.write(d); });
    p.on('close', (code) => resolve({ code, out }));
    setTimeout(() => { p.kill(); resolve({ code: -1, out }); }, 60000);
  });
}

async function main() {
  console.log('══════════ sshterm 测试套件 ══════════\n');
  // 起临时服务端 (--no-open 避免弹浏览器)
  const srv = spawn('node', ['server/index.js', '--port', String(PORT), '--no-open'],
    { cwd: path.join(__dirname, '..') });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  await new Promise((r) => setTimeout(r, 1200));

  const results = [];
  for (const t of tests) {
    process.stdout.write(`\n▶ ${t.name}\n`);
    const { code } = await run(t.cmd, t.args);
    results.push({ ...t, pass: code === 0 });
  }

  srv.kill();
  console.log('\n══════════ 汇总 ══════════');
  let ok = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
    if (r.pass) ok++;
  }
  console.log(`\n${ok}/${results.length} 通过`);
  process.exit(ok === results.length ? 0 : 1);
}
main();
