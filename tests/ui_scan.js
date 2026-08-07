// UI 测试: 端口扫描只需输入 IP (默认常用端口)
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
  await sleep(1000);

  // 1. 打开扫描对话框
  await page.click('#btn-more');
  await sleep(200);
  await page.click('#mi-scan');
  await sleep(300);
  const hasPortInput = await page.evaluate(() => !!document.getElementById('scan-ports'));
  console.log('[1] 端口输入框已移除:', !hasPortInput);

  // 2. 只输 IP 扫描
  console.log('[2] 输入 IP 192.168.1.216 并扫描...');
  await page.type('#scan-host', '192.168.1.216');
  await page.click('#btn-scan-start');
  await sleep(4000);   // 等扫描完成 (15 端口并发)
  const result = await page.$eval('#scan-result', el => el.textContent);
  console.log('    结果:', JSON.stringify(result.slice(0, 100)));

  // 3. 网段 → 网络扫描 (设备发现)
  console.log('[3] 输入网段 192.168.1.210-220 网络扫描...');
  await page.$eval('#scan-host', el => { el.value = '192.168.1.210-220'; });
  await page.click('#btn-scan-start');
  await sleep(5000);
  const netResult = await page.$eval('#scan-result', el => el.textContent);
  console.log('    网络扫描结果:', JSON.stringify(netResult.slice(0, 120)));
  const hasDevice = netResult.includes('192.168.1.216');

  const ok1 = !hasPortInput;
  const ok2 = result.includes('192.168.1.216') && result.includes('22');
  const ok3 = hasDevice;
  console.log(`\n=== 汇总: ${ok1 && ok2 && ok3 ? '✅ 扫描正常(单IP+网段)' : '❌'} ===`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
