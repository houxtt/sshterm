// UI 测试: 分屏 (左右 pane 独立连接/数据流/关闭)
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

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '分屏测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);

  // 1. 分屏
  console.log('[1] 点"⊞ 分屏"...');
  await page.click('#btn-split');
  await sleep(2500);
  const paneCount = await page.$$eval('.term-host.pane1', els => els.length);
  console.log('    分屏 pane 数:', paneCount);

  // 2. 主 pane 输入命令 → 主 pane 回显 (真实点击)
  console.log('[2] 点击主 pane 输入 echo SPLIT_MAIN...');
  const mainBox = await page.$eval('.term-host:not(.pane1)', el => el.getBoundingClientRect().toJSON());
  await page.mouse.click(mainBox.x + 60, mainBox.y + 40);
  await sleep(300);
  await page.keyboard.type('echo SPLIT_MAIN\n');
  await sleep(1500);
  const mainHas = await page.evaluate(() => {
    const hosts = document.querySelectorAll('.term-host:not(.pane1)');
    for (const h of hosts) {
      if (h.querySelector('.xterm-rows')?.textContent.includes('SPLIT_MAIN')) return true;
    }
    return false;
  });
  console.log('    主 pane 收到回显:', mainHas);

  // 2.5 pane1 输入 → pane1 回显 (真实点击右半)
  const pane1Box = await page.$eval('.term-host.pane1', el => el.getBoundingClientRect().toJSON());
  await page.mouse.click(pane1Box.x + 40, pane1Box.y + 40);
  await sleep(300);
  await page.keyboard.type('echo SPLIT_PANE\n');
  await sleep(1500);
  const paneHas = await page.evaluate(() => {
    const h = document.querySelector('.term-host.pane1');
    return h ? h.querySelector('.xterm-rows')?.textContent.includes('SPLIT_PANE') : false;
  });
  console.log('    pane1 收到回显:', paneHas);

  // 3. 关闭 pane
  console.log('[3] 关闭分屏 pane...');
  await page.click('.term-host.pane1 .pane-close');
  await sleep(500);
  const paneAfter = await page.$$eval('.term-host.pane1', els => els.length);
  console.log('    关闭后 pane 数:', paneAfter);

  const ok1 = paneCount === 1;
  const ok2 = mainHas && paneHas;
  const ok3 = paneAfter === 0 && errors.length === 0;
  console.log(`\n=== 汇总: ${ok1 && ok2 && ok3 ? '✅ 分屏正常(双pane独立输入)' : '❌'} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);

  // 清理
  try {
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
