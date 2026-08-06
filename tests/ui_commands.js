// UI 测试: 快捷命令 (保存/记忆/执行) + 连接后自动执行脚本
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
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

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '命令测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  // 连接后自动执行脚本
  await page.type('#f-autocmds', 'echo AUTO_CMD_1\necho AUTO_CMD_2');
  await page.click('#btn-dlg-conn');
  await sleep(3000);

  // 1. 连接后自动执行
  const autoOk = await page.evaluate(() => {
    const h = document.querySelector('.term-host:not(.pane1)');
    const text = h?.querySelector('.xterm-rows')?.textContent || '';
    return text.includes('AUTO_CMD_1') && text.includes('AUTO_CMD_2');
  });
  console.log('[1] 连接后自动执行脚本:', autoOk);

  // 2. 打开命令面板, 保存命令 (会话1)
  console.log('[2] 打开⚡命令面板并保存命令(会话1)...');
  await page.click('#btn-cmds');
  await sleep(300);
  const cur1 = await page.$eval('#cmd-cur', el => el.textContent);
  console.log('    面板当前会话:', JSON.stringify(cur1));
  await page.type('#cmd-name', '查看主机名');
  await page.type('#cmd-content', 'hostname');
  await page.click('#btn-cmd-add');
  await sleep(300);
  const listCount = await page.$$eval('#cmd-list .cmd-item', els => els.length);
  console.log('    会话1 命令列表项:', listCount);
  await page.click('#cmds-close');

  // 3. 点击命令执行
  console.log('[3] 点击命令执行...');
  await page.click('#btn-cmds');
  await sleep(300);
  await page.click('#cmd-list .cmd-item');
  await sleep(1500);
  const execOk = await page.evaluate(() => {
    const h = document.querySelector('.term-host:not(.pane1)');
    const text = h?.querySelector('.xterm-rows')?.textContent || '';
    return text.includes('hostname');
  });
  console.log('    命令已发送并回显:', execOk);
  await page.click('#cmds-close');

  // 4. 会话隔离: 开第二个会话 (不同会话名) → 命令面板应为空
  console.log('[4] 开第二个会话, 验证命令独立...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '命令测试2');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  await page.click('#btn-cmds');
  await sleep(300);
  const listCount2 = await page.$$eval('#cmd-list .cmd-item', els => els.length);
  const cur2 = await page.$eval('#cmd-cur', el => el.textContent);
  console.log('    会话2 命令数:', listCount2, '| 当前:', JSON.stringify(cur2));
  await page.click('#cmds-close');

  const ok = autoOk && listCount >= 1 && execOk && listCount2 === 0;
  console.log(`\n=== 汇总: ${ok ? '✅ 命令保存/执行/自动脚本/会话隔离正常' : '❌'} ===`);

  // 清理 (删除测试命令)
  await page.evaluate(() => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sshterm.commands.')) localStorage.removeItem(k);
    }
  });
  try {
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
