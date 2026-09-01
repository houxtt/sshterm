// 复现: 刷新页面后会话列表是否还在
const puppeteer = require('./puppeteer_test');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  // 首次加载
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);
  const s1 = await page.evaluate(() => ({
    ws: document.getElementById('conn-status-text').textContent,
    sessions: [...document.querySelectorAll('#session-list .s-name')].map(e => e.textContent),
    sessionCount: document.querySelectorAll('#session-list li').length,
  }));
  console.log('[1] 首次加载: WS:', s1.ws, '| 会话数:', s1.sessionCount);
  console.log('    会话:', s1.sessions.join(', '));

  // 刷新
  console.log('[2] 刷新页面...');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  const s2 = await page.evaluate(() => ({
    ws: document.getElementById('conn-status-text').textContent,
    sessions: [...document.querySelectorAll('#session-list .s-name')].map(e => e.textContent),
    sessionCount: document.querySelectorAll('#session-list li').length,
    batchMode: !document.getElementById('batch-bar').classList.contains('hidden'),
  }));
  console.log('[3] 刷新后: WS:', s2.ws, '| 会话数:', s2.sessionCount);
  console.log('    会话:', s2.sessions.join(', '));

  const ok = s1.sessionCount > 0 && s2.sessionCount > 0 && s1.sessionCount === s2.sessionCount;
  console.log(`\n=== ${ok ? '✅ 刷新后会话保留' : '❌ 刷新后会话丢失'} ===`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
