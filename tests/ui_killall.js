// UI 测试: 全部断开按钮 + 刷新残留清理
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 1. 打开两个 SSH 连接
  console.log('[1] 打开 2 个 SSH 连接...');
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-new');
    await sleep(300);
    await page.type('#f-name', `全部断开测试${i}`);
    await page.type('#f-host', '192.168.1.216');
    await page.type('#f-user', 'logic');
    await page.type('#f-password', '1');
    await page.click('#btn-dlg-conn');
    await sleep(2200);
  }
  const tabCount = await page.$$eval('.tab', els => els.length);
  console.log('    标签数:', tabCount);

  // 2. 点"全部断开" → 确认 → 所有标签消失
  console.log('[2] 点"⏹ 全部断开"...');
  await page.click('#btn-killall');
  await sleep(300);
  await page.click('#btn-killall');   // 触发 confirm? puppeteer dialog accept 自动
  await sleep(800);
  const tabCountAfter = await page.$$eval('.tab', els => els.length);
  const welcomeShown = await page.$eval('#welcome', el => !el.classList.contains('hidden'));
  console.log('    全部断开后标签数(应=0):', tabCountAfter, '| 欢迎页:', welcomeShown);

  // 3. 刷新页面 → 服务端无残留 (通过日志确认 cleanup)
  console.log('[3] 刷新页面 (cleanup 清理残留)...');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  const wsState = await page.$eval('#conn-status-text', el => el.textContent);
  console.log('    刷新后 WS:', wsState);

  const ok1 = tabCount === 2;
  const ok2 = tabCountAfter === 0 && welcomeShown;
  const ok3 = wsState.includes('已连接') && errors.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`多连接: ${ok1 ? '✅' : '❌'}  全部断开: ${ok2 ? '✅' : '❌'}  刷新正常: ${ok3 ? '✅' : '❌'} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
