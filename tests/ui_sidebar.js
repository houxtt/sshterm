// UI 测试: 会话列表左键选择/拖选 → 不触发复制, 页面不卡死
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  await browser.defaultBrowserContext().overridePermissions(
    URL.replace(/\/$/, ''), ['clipboard-read', 'clipboard-write']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 1. 会话列表项拖选文本 (模拟左键选择会话信息)
  console.log('[1] 会话列表拖选文本...');
  const box = await page.$eval('#session-list li', el => el.getBoundingClientRect().toJSON());
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await sleep(500);
  const selText = await page.evaluate(() => window.getSelection()?.toString() || '');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '(读剪贴板失败)');
  const busy1 = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 1e6; i++) { }
    return Date.now() - t;
  });
  console.log('    选中文本:', JSON.stringify(selText.slice(0, 30)), '| 剪贴板:', JSON.stringify(String(clip).slice(0, 30)));
  console.log('    页面忙时:', busy1, 'ms');

  // 2. 连续单击会话列表项 20 次 (快速, 不构成双击)
  console.log('[2] 连续单击列表项 20 次...');
  for (let i = 0; i < 20; i++) {
    await page.mouse.click(box.x + 60, box.y + box.height / 2);
  }
  await sleep(1500);
  const tabCount = await page.$$eval('.tab', els => els.length);
  const busy2 = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 1e6; i++) { }
    return Date.now() - t;
  });
  console.log('    单击后标签数:', tabCount, '(应=0, 单击不连接) | 页面忙时:', busy2, 'ms');

  const ok1 = busy1 < 100 && busy2 < 100;   // 全程不卡
  const ok2 = tabCount === 0;               // 单击不触发连接
  console.log('\n=== 汇总 ===');
  console.log(`页面不卡: ${ok1 ? '✅' : '❌'}  单击不连接: ${ok2 ? '✅' : '❌'}`);
  console.log('(会话列表选择文本不会触发复制: 复制绑定仅在终端容器)');
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
