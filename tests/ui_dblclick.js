// UI 测试: 会话列表连续左键/双击 → 防抖只开一个连接, 页面不卡死
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  const sessionCount = await page.$$eval('#session-list li', els => els.length);
  console.log('[0] 会话列表项:', sessionCount);
  if (!sessionCount) { console.log('⚠️ 无会话可测'); process.exit(1); }

  // 1. 连续派发 dblclick (模拟连续双击/连点) 8 次 → 防抖应只开 1 个
  console.log('[1] 连续触发双击 8 次...');
  await page.evaluate(() => {
    const li = document.querySelector('#session-list .s-row');
    for (let i = 0; i < 8; i++) {
      li.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
  });
  await sleep(2000);
  const tabCountAfter = await page.$$eval('.tab', els => els.length);
  console.log('    连续双击后标签数:', tabCountAfter, '(防抖应只开 1 个)');

  // 2. 页面响应性检查
  const busy = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 1e6; i++) { /* 忙等 */ }
    return Date.now() - t;
  });
  console.log('    页面忙时:', busy, 'ms');

  // 3. 等 1.5s 后正常双击 → 应能再开一个
  console.log('[2] 等 1.5s 后正常双击...');
  await sleep(1500);
  await page.evaluate(() => {
    const li = document.querySelector('#session-list .s-row');
    li.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await sleep(2000);
  const tabCountFinal = await page.$$eval('.tab', els => els.length);
  console.log('    正常双击后标签数:', tabCountFinal, '(应比之前多)');

  const ok1 = tabCountAfter <= 2;                    // 防抖生效
  const ok2 = busy < 100;                            // 页面不卡
  const ok3 = tabCountFinal > tabCountAfter;         // 正常操作仍可开新连接
  console.log('\n=== 汇总 ===');
  console.log(`连续点击防抖: ${ok1 ? '✅' : '❌'}  页面响应: ${ok2 ? '✅' : '❌'}  正常双击可用: ${ok3 ? '✅' : '❌'}`);

  // 清理
  await page.click('#btn-killall');
  await sleep(500);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
