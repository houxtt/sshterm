// UI 功能测试 v3: 日志面板 + 批量删除 + 复制不崩 (三项新功能)
const puppeteer = require('puppeteer-core');
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

  // ===== 功能2: 批量删除 (先保存会话, 产生日志) =====
  // 测试只保护启动时已有的会话, 不依赖特定用户环境(例如 gk1221/logic/1)
  const baselineSessions = await page.$$eval('#session-list .s-name', els => els.map(e => e.textContent));
  console.log('[1] 保存 3 个测试会话...');
  
  for (let i = 1; i <= 3; i++) {
    await page.evaluate(() => document.getElementById('btn-new').click());
    await sleep(250);
    await page.type('#f-name', `批量测试${i}`);
    await page.select('#f-type', 'telnet');
    await page.type('#t-host', `192.168.1.1${i}`);
    await page.click('#btn-dlg-save');
    await sleep(400);
  }
  const before = await page.evaluate(() => sessions.length);
  console.log('    会话总数:', before);

  // ===== 功能1: 日志面板 (此时服务端已有"新建会话"日志) =====
  console.log('[2] 打开日志面板...');
  await page.click('#btn-more');
  await sleep(200);
  await page.click('#mi-log');
  await sleep(500);
  const logVisible = await page.$eval('#dlg-log-mask', el => !el.classList.contains('hidden'));
  const logCount = await page.$$eval('#log-list .log-line', els => els.length);
  const logHasSave = await page.evaluate(() =>
    document.getElementById('log-list').textContent.includes('新建会话'));
  console.log('    面板打开:', logVisible, '| 日志条数:', logCount, '| 含"新建会话":', logHasSave);
  await page.click('#log-close');
  await sleep(200);

  console.log('[3] 进入批量模式, 勾选 2 个测试会话删除...');
  await page.click('#btn-batch');
  await sleep(300);
  const cbs = await page.$$eval('#session-list .b-cb', els => els.length);
  console.log('    复选框出现:', cbs > 0);
  // 只勾选"批量测试"前缀的会话 (绝不按位置, 避免误删用户会话)
  await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#session-list .b-cb')]
      .filter(b => /^批量测试/.test(b.closest('.s-row').querySelector('.s-name').textContent));
    boxes.slice(0, 2).forEach(b => b.click());
  });
  await sleep(200);
  const selN = await page.$eval('#batch-n', el => el.textContent);
  console.log('    已选数量:', selN);
  await page.click('#batch-del');
  await sleep(500);
  const after = await page.evaluate(() => sessions.length);
  const batchBarHidden = await page.$eval('#batch-bar', el => el.classList.contains('hidden'));
  console.log('    删除后会话数:', after, '| 批量栏已收起:', batchBarHidden);

  // ===== 功能3: 复制不崩 (连接后拖选) =====
  console.log('[4] SSH 连接后拖选复制 (防抖+截断验证)...');
  await page.click('#btn-new');
  await sleep(250);
  await page.type('#f-name', '复制验证');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  const box = await page.$eval('.term-host:not(.hidden)', el => el.getBoundingClientRect().toJSON());
  await page.mouse.move(box.x + 10, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 8, { steps: 5 });
  await page.mouse.up();
  await sleep(500);
  const alive = await page.evaluate(() => document.visibilityState === 'visible' && !!document.querySelector('.tab'));
  console.log('    拖选后页面存活:', alive, '| JS错误:', errors.length ? errors.join(' | ') : '(无)');

  // 清理测试会话: 只删除本次测试创建的 (名字带"测试"前缀), 绝不全选删除
  await page.evaluate(() => {
    document.getElementById('btn-batch').click();
    const boxes = [...document.querySelectorAll('#session-list .b-cb')]
      .filter(b => /^(批量测试|复制验证|UI测试)/.test(
        b.closest('.s-row').querySelector('.s-name').textContent));
    boxes.forEach(b => b.click());
    if (boxes.length) document.getElementById('batch-del').click();
  });
  await sleep(500);

  // ===== 会话保护断言 =====
  const finalSessions = await page.evaluate(() =>
    [...document.querySelectorAll('#session-list .s-name')].map(e => e.textContent));
  const missingBaseline = baselineSessions.filter(n => !finalSessions.includes(n));
  console.log('    启动前会话缺失:', missingBaseline.length ? missingBaseline.join(',') : '(全部保留 ✅)');

  const ok1 = logVisible && logCount > 0 && logHasSave;
  const ok2 = before > 0 && cbs > 0 && selN === '2' && after === before - 2 && batchBarHidden;
  const ok3 = alive && errors.length === 0;
  const ok4 = missingBaseline.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`日志面板: ${ok1 ? '✅' : '❌'}  批量删除: ${ok2 ? '✅' : '❌'}  复制不崩: ${ok3 ? '✅' : '❌'}  会话保护: ${ok4 ? '✅' : '❌'}`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 && ok4 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
