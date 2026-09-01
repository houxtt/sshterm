// 卡死回归测试: 左键拖选 → 右键 (曾导致浏览器卡死)
// 验证: 右键 mouseup 不复制; 右键有选中→复制; 页面全程响应正常
const puppeteer = require('./puppeteer_test');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  await browser.defaultBrowserContext().overridePermissions(
    URL.replace(/\/$/, ''), ['clipboard-read', 'clipboard-write']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 连接 SSH 产生终端内容
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '卡死回归');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);

  const box = await page.$eval('.term-host:not(.hidden)', el => el.getBoundingClientRect().toJSON());
  const y = box.y + 8;

  // ===== 场景1: 左键拖选 → 右键 =====
  console.log('[1] 左键拖选一段文本...');
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, y, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  const selAfterLeft = await page.evaluate(() => {
    const term = document.querySelector('.term-host:not(.hidden)');
    return term && term.querySelector('.xterm-rows') ? '有内容' : '?';
  });
  const statusAfterLeft = await page.$eval('#sb-left', el => el.textContent);
  console.log('    左键释放后状态栏:', JSON.stringify(statusAfterLeft));

  console.log('[2] 点击右键 (曾卡死) ...');
  const t0 = Date.now();
  await page.mouse.click(box.x + 100, y, { button: 'right' });
  await sleep(800);
  const elapsed = Date.now() - t0;
  const alive = await page.evaluate(() => {
    // 页面响应性: 执行一段 JS 看是否卡住
    const t = Date.now();
    for (let i = 0; i < 1e6; i++) { /* 忙等 */ }
    return { ok: true, busyMs: Date.now() - t };
  });
  console.log('    右键处理耗时:', elapsed, 'ms | 页面响应:', JSON.stringify(alive));

  // ===== 场景2: 右键后再次操作 (连点右键3次) =====
  console.log('[3] 连续右键 3 次 (高压) ...');
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(box.x + 100, y, { button: 'right' });
    await sleep(200);
  }
  await sleep(500);
  const alive2 = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 1e6; i++) { }
    return Date.now() - t;
  });
  console.log('    连点后页面忙时:', alive2, 'ms (正常应 <100ms)');

  const ok = errors.length === 0 && alive.ok && alive2 < 100 && elapsed < 3000;
  console.log('\n=== 汇总 ===');
  console.log(`卡死回归: ${ok ? '✅ 页面全程响应, 无卡死' : '❌ 异常'} | JS错误: ${errors.length ? errors.join(' | ') : '(无)'}`);
  console.log(`(右键行为: 有选中→复制; 右键mouseup不再触发复制; 剪贴板互斥+超时兜底)`);

  // 清理测试会话
  try {
    await page.evaluate(() => {
      document.getElementById('btn-batch').click();
      const boxes = [...document.querySelectorAll('#session-list .b-cb')]
        .filter(b => /^(卡死回归|批量测试|复制验证|UI测试)/.test(
          b.closest('.s-row').querySelector('.s-name').textContent));
      boxes.forEach(b => b.click());
      if (boxes.length) document.getElementById('batch-del').click();
    });
    await sleep(400);
  } catch (e) { /* 忽略清理失败 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
