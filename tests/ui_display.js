// UI 回归: `display <远程图片>` 命令拦截
// 验证前端在 SSH 会话里拦截 `display` 命令, 经 SFTP 拉图并在终端内联渲染,
// 而不会把命令转发到远端 (避免远端 ImageMagick 的 "Unable to open X server")。
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const puppeteer = require('./puppeteer_test');
const URL = process.argv[2] || 'http://127.0.0.1:8894/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 自启源码模式 server
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-disp-'));
  const srv = spawn(process.execPath, ['server/index.js', '--port', '8894', '--no-open'], {
    cwd: 'D:/sshterm', env: { ...process.env, HOME: prof, USERPROFILE: prof }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(3000);

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  const downloadHits = [];
  page.on('request', (req) => { if (req.url().includes('/api/sftp/download')) downloadHits.push(req.url()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404') && !m.text().includes('400')) errors.push('console: ' + m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);

  console.log('[1] 建立 SSH 标签 (不发起真实连接)...');
  const created = await page.evaluate(() => {
    const tab = newTab({ type: 'ssh', name: 'display 验证', host: '127.0.0.1', port: 1,
      user: 'sshterm', password: '', auth: 'password' }, { connect: false });
    return !!tab && !!tab.imageAddon;
  });
  console.log('    标签+图片插件:', created ? '✅' : '❌');
  await sleep(400);

  console.log('[2] 输入 `display /tmp/x.png` (应被拦截, 触发 SFTP 取图)...');
  await page.evaluate(() => {
    const tab = tabs.find(t => t.cfg.name === 'display 验证');
    tab.term._core._onData.fire('display /tmp/x.png\r');
  });
  await sleep(800);
  const blocked = await page.evaluate(() => {
    const tab = tabs.find(t => t.cfg.name === 'display 验证');
    return tab._inputLine === '';
  });
  console.log('    拦截触发(输入被消费) + 取图:', (blocked && downloadHits.length >= 1) ? '✅' : '❌', '| SFTP 请求数:', downloadHits.length);

  console.log('[3] 输入普通命令 `echo hello` (不应触发取图)...');
  const before = downloadHits.length;
  await page.evaluate(() => {
    const tab = tabs.find(t => t.cfg.name === 'display 验证');
    tab.term._core._onData.fire('echo hello\r');
  });
  await sleep(500);
  const notBlocked = downloadHits.length === before;
  console.log('    普通命令未被拦截:', notBlocked ? '✅' : '❌');

  console.log('[4] 清理测试标签...');
  await page.evaluate(() => {
    const tab = tabs.find(t => t.cfg.name === 'display 验证');
    if (tab) doCloseTab(tab.id);
  });
  await sleep(400);
  const cleaned = await page.evaluate(() => !tabs.some(t => t.name === 'display 验证'));
  console.log('    标签已关闭:', cleaned ? '✅' : '❌');

  const ok = created && blocked && downloadHits.length >= 1 && notBlocked && cleaned && errors.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`标签: ${created ? '✅' : '❌'}  拦截: ${blocked ? '✅' : '❌'}  `
    + `SFTP取图: ${downloadHits.length >= 1 ? '✅' : '❌'}  普通命令放行: ${notBlocked ? '✅' : '❌'}  `
    + `清理: ${cleaned ? '✅' : '❌'}  JS错误: ${errors.length ? '❌ ' + errors.join(' | ') : '(无) ✅'}`);

  try { srv.kill(); } catch (e) {}
  try { browser.process() && browser.process().kill(); } catch (e) {}
  fs.rmSync(prof, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
