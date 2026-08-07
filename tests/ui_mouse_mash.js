// UI 测试: 终端选中文本后 左键/右键/双击 无序乱点 → 页面不卡死
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '乱点测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);

  // 1. 产生大量终端输出并选中
  console.log('[1] 生成大文本输出并拖选...');
  await page.keyboard.type('seq 2000\n');   // 产生 ~14KB 输出
  await sleep(2500);
  const box = await page.$eval('.term-host:not(.hidden)', el => el.getBoundingClientRect().toJSON());
  const y = box.y + 8;
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, y + 300, { steps: 12 });
  await page.mouse.up();
  await sleep(400);
  const selLen = await page.evaluate(() => window.getSelection()?.toString().length || 0);
  console.log('    选中文本长度:', selLen);

  // 2. 无序乱点 100 次 (无间隔, 极端快速): 左键/右键/双击 交替
  console.log('[2] 快速乱点 100 次 (无间隔)...');
  const actions = [
    () => page.mouse.click(box.x + 100, y),                       // 左键单击
    () => page.mouse.click(box.x + 100, y, { button: 'right' }),  // 右键
    () => { page.mouse.click(box.x + 100, y); page.mouse.click(box.x + 100, y); }, // 双击
    () => page.mouse.click(box.x + 150, y, { button: 'right' }),
    () => page.mouse.click(box.x + 50, y),                        // 左键(点掉选择)
    () => page.mouse.click(box.x + 120, y, { button: 'right' }),  // 右键(无选中)
  ];
  for (let i = 0; i < 100; i++) {
    await actions[i % actions.length]();
  }
  // 乱点结束后立即检查页面响应 (定时器合并后最多 1 个在跑)
  const busyMid = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 2e6; i++) { }
    return Date.now() - t;
  });
  await sleep(1200);
  const busy = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 2e6; i++) { }
    return Date.now() - t;
  });
  const alive = await page.evaluate(() => !!document.querySelector('#toolbar'));
  console.log('    乱点中页面忙时:', busyMid, 'ms | 结束后:', busy, 'ms | 存活:', alive);

  const ok = busy < 100 && alive && errors.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`大文本+乱点 50 次不卡: ${ok ? '✅' : '❌'} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);
  console.log('(修复: 同步防抖, 快速点击不排队定时器, 无 getSelection 风暴)');

  // 清理
  try {
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
