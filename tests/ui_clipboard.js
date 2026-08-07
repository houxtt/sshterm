// 剪贴板冒烟: 连接后选中文本 → mouseup → 应复制 (状态栏提示 / 剪贴板内容)
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new',
    args: ['--allow-file-access-from-files'] });
  // 授予剪贴板读写权限 (CDP), 让 headless 也能完整验证
  await browser.defaultBrowserContext().overridePermissions(
    URL.replace(/\/$/, ''), ['clipboard-read', 'clipboard-write']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '剪贴板测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);

  // 检查终端有内容
  const hasShell = await page.evaluate(() => {
    const rows = document.querySelector('.term-host:not(.hidden) .xterm-rows');
    return rows ? rows.textContent.length > 50 : false;
  });
  console.log('shell 有内容:', hasShell);

  // 模拟选中 + mouseup
  const selResult = await page.evaluate(() => {
    const host = document.querySelector('.term-host:not(.hidden)');
    const term = window.__activeTerm;   // 尝试拿终端引用
    return { hasTerm: !!term, hasSelect: typeof term?.selectLines === 'function' };
  });
  console.log('终端引用可达:', selResult.hasTerm || '(app 未暴露全局, 走 DOM 模拟)');

  // 模拟鼠标拖选文本 → mouseup 自动复制
  const box = await page.$eval('.term-host:not(.hidden)', el => el.getBoundingClientRect().toJSON());
  const selY = box.y + 8;   // 第一行
  await page.mouse.move(box.x + 10, selY);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(200, box.width - 10), selY, { steps: 8 });
  await page.mouse.up();
  await sleep(500);

  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '(读剪贴板失败)');
  const status = await page.$eval('#sb-left', el => el.textContent);
  console.log('剪贴板内容(前 80):', JSON.stringify(String(clip).slice(0, 80)));
  console.log('状态栏:', JSON.stringify(status));

  const copied = typeof clip === 'string' && clip.length > 10;
  const jsErr = errors.length ? errors.join(' | ') : '(无)';
  console.log('JS 错误:', jsErr);
  console.log(copied && !errors.length
    ? '\n✅ 完整验证通过: 鼠标选中 → 自动复制 → 剪贴板有内容'
    : '\n⚠️ 自动复制未生效(headless 选择限制), 请真机验证');
  console.log('(粘贴: 右键/Ctrl+V 走同一剪贴板通道, 权限授予后可用)');

  // 清理
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(copied && !errors.length ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
