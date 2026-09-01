// UI 测试: 串口日志开关 + 定时发送
const puppeteer = require('./puppeteer_test');
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

  // 打开串口会话 (COM1)
  console.log('[1] 打开串口 COM1...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '串口工具测试');
  await page.select('#f-type', 'serial');
  await page.select('#s-port', 'COM1');
  await page.click('#btn-dlg-conn');
  await sleep(1500);

  // 1. 定时发送
  console.log('[1] 点"⏱ 定时"...');
  await page.click('#btn-more');
  await sleep(200);
  await page.click('#mi-timer');
  await sleep(300);
  const dlgVisible = await page.$eval('#dlg-timer-mask', el => !el.classList.contains('hidden'));
  console.log('    定时对话框:', dlgVisible);
  await page.type('#tm-content', 'AT');
  await page.type('#tm-interval', '500');
  await page.click('#btn-tm-start');
  await sleep(300);
  const status2 = await page.$eval('#sb-left', el => el.textContent);
  console.log('    开始后状态:', JSON.stringify(status2));
  const timerOn = status2.includes('定时发送已开始');

  // 2. 停止
  console.log('[2] 停止...');
  await page.click('#btn-more');
  await sleep(200);
  await page.click('#mi-timer');
  await sleep(300);
  await page.click('#btn-tm-stop');
  await sleep(300);
  const status3 = await page.$eval('#sb-left', el => el.textContent);
  console.log('    停止后状态:', JSON.stringify(status3));
  const timerOff = status3.includes('已停止');

  const ok = dlgVisible && timerOn && timerOff;
  console.log(`\n=== 汇总: ${ok ? '✅ 定时发送正常' : '❌'} ===`);

  // 清理
  try {
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
