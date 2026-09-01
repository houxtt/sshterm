// UI 测试: 串口占用弹窗 (模拟 occupied error 消息注入)
// 注: chrome-headless-shell 渲染器在真实串口连接时崩溃(Edge 151 headless bug),
//     实际占用检测链路已由 e2e_serial_occupied.js 验证; 此处验证前端弹窗交互
const puppeteer = require('./puppeteer_test');
const CHS = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHS, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 先创建 SSH tab (chrome-headless-shell 下 SSH 连接稳定不崩)
  await page.click('#btn-new');
  await sleep(400);
  await page.type('#f-name', '占用测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2000);
  // 把 tab cfg 改成串口配置 (模拟串口会话)
  await page.evaluate(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    tab.cfg = { type: 'serial', name: '串口测试', port: 'COM1', baudRate: 115200 };
    tab.state = 'connecting';
  });

  // 模拟 occupied error 消息 (同真实服务端格式)
  console.log('[1] 模拟串口占用 error 消息...');
  await page.evaluate(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    handleMsg({ type: 'error', id: tab.id, msg: '串口打开失败: 串口 COM1 被其他程序占用(如 MobaXterm/串口助手), 可等待重试或强制释放', occupied: true });
  });
  await sleep(400);
  const occVisible = await page.$eval('#dlg-occ-mask', el => !el.classList.contains('hidden'));
  const occMsg = occVisible ? await page.$eval('#occ-msg', el => el.textContent) : '';
  console.log('[2] 占用弹窗显示:', occVisible, '| 消息:', JSON.stringify(occMsg.slice(0, 40)));

  // 点"等待重试"
  let waitOk = false;
  if (occVisible) {
    console.log('[3] 点"⏳ 等待重试"...');
    await page.click('#btn-occ-wait');
    await sleep(500);
    const status = await page.$eval('#sb-left', el => el.textContent);
    console.log('    状态:', JSON.stringify(status.slice(0, 40)));
    waitOk = status.includes('自动重试');
    await page.evaluate(() => stopOccRetry());
  }

  // 再次触发弹窗 → 点"强制释放"(验证按钮存在且发消息)
  console.log('[4] 再触发弹窗, 点"⚡ 强制释放"...');
  await page.evaluate(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    handleMsg({ type: 'error', id: tab.id, msg: '串口打开失败: 串口 COM1 被其他程序占用', occupied: true });
  });
  await sleep(300);
  await page.click('#btn-occ-force');
  await sleep(400);
  const status2 = await page.$eval('#sb-left', el => el.textContent);
  console.log('    强制释放状态:', JSON.stringify(status2.slice(0, 40)));
  const forceOk = status2.includes('强制释放中');

  const ok = occVisible && waitOk && forceOk;
  console.log(`\n=== 汇总: ${ok ? '✅ 串口占用弹窗/等待重试/强制释放入口 正常' : '❌'} ===`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
