// UI 测试: 终端搜索 Ctrl+F (SearchAddon 高亮 + 计数)
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

  // 连接 SSH 并产生输出
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '搜索测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  await page.keyboard.type('echo SEARCH_MARKER_XYZ\n');
  await sleep(1500);

  // 1. Ctrl+F 打开搜索条
  console.log('[1] Ctrl+F 打开搜索...');
  await page.keyboard.down('Control');
  await page.keyboard.press('f');
  await page.keyboard.up('Control');
  await sleep(300);
  const barVisible = await page.$eval('#search-bar', el => !el.classList.contains('hidden'));
  console.log('    搜索条显示:', barVisible);

  // 2. 输入关键字
  console.log('[2] 输入 SEARCH_MARKER...');
  await page.keyboard.type('SEARCH_MARKER');
  await sleep(600);
  const count = await page.$eval('#search-count', el => el.textContent);
  console.log('    计数:', JSON.stringify(count));

  // 3. Esc 关闭
  console.log('[3] Esc 关闭...');
  await page.keyboard.press('Escape');
  await sleep(300);
  const barHidden = await page.$eval('#search-bar', el => el.classList.contains('hidden'));
  console.log('    搜索条关闭:', barHidden);

  const ok1 = barVisible;
  const ok2 = count.includes('/') && !count.startsWith('0');
  const ok3 = barHidden && errors.length === 0;
  console.log(`\n=== 汇总: ${ok1 && ok2 && ok3 ? '✅ 搜索/高亮正常' : '❌'} | 计数=${JSON.stringify(count)} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);

  // 清理
  try {
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
