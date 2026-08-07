// UI 测试: 语言切换 (中文 ↔ English)
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);

  // 1. 默认中文
  const zhNew = await page.$eval('#btn-new', el => el.textContent);
  console.log('[1] 初始按钮:', JSON.stringify(zhNew));

  // 2. 切英文
  await page.click('#btn-lang');
  await sleep(300);
  const enNew = await page.$eval('#btn-new', el => el.textContent);
  const enSide = await page.$eval('#side-title', el => el.textContent).catch(() => '');
  const enKill = await page.$eval('#btn-killall', el => el.textContent);
  console.log('[2] 切英文后:', JSON.stringify(enNew), '| 全部断开:', JSON.stringify(enKill));
  const sideText = await page.evaluate(() =>
    document.querySelector('.side-head span')?.textContent || '');
  console.log('    侧栏标题:', JSON.stringify(sideText));

  // 3. 切回中文
  await page.click('#btn-lang');
  await sleep(300);
  const zhBack = await page.$eval('#btn-new', el => el.textContent);
  console.log('[3] 切回中文:', JSON.stringify(zhBack));

  const ok1 = zhNew.includes('新建连接');
  const ok2 = enNew.includes('New') && enKill.includes('Disconnect');
  const ok3 = zhBack.includes('新建连接');
  console.log(`\n=== 汇总: ${ok1 && ok2 && ok3 ? '✅ 语言切换正常' : '❌'} ===`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
