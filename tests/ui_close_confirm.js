// UI 测试: 关闭会话确认框 (取消保留 / 确认关闭 / 连接真实断开)
const puppeteer = require('./puppeteer_test');
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

  // 1. 连接 SSH (活跃连接)
  console.log('[1] 连接 SSH (192.168.1.216)...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '关闭确认测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  const dot = await page.$eval('.tab.active .t-state', el => el.textContent);
  console.log('    状态点:', dot);

  // 2. 点 ✕ → 确认框应出现, 标签保留
  console.log('[2] 点 ✕ → 确认框出现...');
  await page.click('.tab .t-close');
  await sleep(300);
  const maskVisible = await page.$eval('#dlg-close-mask', el => !el.classList.contains('hidden'));
  const tabCountAfterX = await page.$$eval('.tab', els => els.length);
  const infoText = await page.$eval('#close-info', el => el.textContent);
  console.log('    确认框显示:', maskVisible, '| 标签数(应=1):', tabCountAfterX, '| 提示:', JSON.stringify(infoText.trim().slice(0, 40)));

  // 3. 点"取消" → 确认框消失, 标签保留, 连接仍活跃
  console.log('[3] 点"取消" → 标签保留...');
  await page.click('#btn-close-cancel');
  await sleep(300);
  const maskHidden = await page.$eval('#dlg-close-mask', el => el.classList.contains('hidden'));
  const tabCountAfterCancel = await page.$$eval('.tab', els => els.length);
  const stillActive = await page.$eval('.tab.active .t-state', el => el.textContent);
  console.log('    确认框已关:', maskHidden, '| 标签数(应=1):', tabCountAfterCancel, '| 状态(应🟢):', stillActive);

  // 4. 再点 ✕ → 点"确认关闭" → 标签消失, 服务端连接断开
  console.log('[4] 再点 ✕ → 确认关闭 → 标签消失...');
  await page.click('.tab .t-close');
  await sleep(300);
  await page.click('#btn-close-ok');
  await sleep(800);
  const tabCountAfterOk = await page.$$eval('.tab', els => els.length);
  const welcomeShown = await page.$eval('#welcome', el => !el.classList.contains('hidden'));
  console.log('    标签数(应=0):', tabCountAfterOk, '| 欢迎页显示:', welcomeShown);

  // 5. 服务端连接已断开验证 (通过日志面板确认"关闭会话"已记录)
  await page.click('#btn-more');
  await sleep(200);
  await page.click('#mi-log');
  await sleep(400);
  const logHasClose = await page.evaluate(() =>
    document.getElementById('log-list').textContent.includes('关闭会话「关闭确认测试」'));
  console.log('    操作日志含"关闭会话":', logHasClose);
  await page.click('#log-close');

  const ok1 = maskVisible && tabCountAfterX === 1;
  const ok2 = maskHidden && tabCountAfterCancel === 1 && stillActive === '🟢';
  const ok3 = tabCountAfterOk === 0 && welcomeShown;
  const ok4 = logHasClose && errors.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`确认框弹出: ${ok1 ? '✅' : '❌'}  取消保留: ${ok2 ? '✅' : '❌'}  确认关闭: ${ok3 ? '✅' : '❌'}  日志+无错: ${ok4 ? '✅' : '❌'}`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 && ok4 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
