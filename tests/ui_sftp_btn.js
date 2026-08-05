// UI 测试: 文件面板按钮联动 + 打开定位到 shell 当前目录
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

  // ===== 需求1: 按钮仅 SSH 已连接时可用 =====
  // 1a. 无会话时按钮应禁用
  const disabledInit = await page.$eval('#btn-sftp', el => el.disabled);
  console.log('[1] 无会话时按钮禁用:', disabledInit);

  // 1b. 打开 Telnet 会话 → 按钮应禁用
  console.log('[2] 打开 Telnet 会话...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '按钮测试Telnet');
  await page.select('#f-type', 'telnet');
  await page.type('#t-host', '127.0.0.1');
  await page.click('#btn-dlg-conn');
  await sleep(1500);   // 连不上也无妨, 标签存在即可
  const disabledTelnet = await page.$eval('#btn-sftp', el => el.disabled);
  console.log('    Telnet 会话时按钮禁用:', disabledTelnet);
  // 关掉 telnet 标签
  await page.click('.tab .t-close');
  await sleep(300);
  await page.click('#btn-close-ok').catch(() => {});
  await sleep(400);

  // 1c. 打开 SSH 会话 → 连接后按钮应可用
  console.log('[3] 打开 SSH 会话...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '定位测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  const disabledSsh = await page.$eval('#btn-sftp', el => el.disabled);
  console.log('    SSH 已连接时按钮禁用:', disabledSsh);

  // ===== 需求2: 打开面板定位到 shell 当前目录 =====
  console.log('[4] cd 到子目录, 打开文件面板...');
  // 点击终端区域获得键盘焦点 (确保 cd 命令发到终端)
  const box = await page.$eval('.term-host:not(.hidden)', el => el.getBoundingClientRect().toJSON());
  await page.mouse.click(box.x + 100, box.y + 50);
  await sleep(300);
  await page.keyboard.type('cd /home/logic/1221\n');
  await sleep(3000);   // 等 shell 执行完 cd
  // 验证 cd 已执行 (提示符应变为 ~/1221)
  const prompt = await page.evaluate(() => {
    const h = document.querySelector('.term-host:not(.hidden)');
    const text = h ? (h.querySelector('.xterm-rows')?.textContent || '') : '';
    return text.includes('~/1221') ? 'cd成功' : 'cd未确认';
  });
  console.log('    cd 状态:', prompt);
  await page.click('#btn-sftp');
  await sleep(1500);
  const sftpPath = await page.$eval('#sftp-path', el => el.value);
  const status = await page.$eval('#sftp-status', el => el.textContent);
  console.log('    文件面板路径:', JSON.stringify(sftpPath), '| 状态:', JSON.stringify(status));

  const ok1 = disabledInit && disabledTelnet;
  const ok2 = !disabledSsh;
  const ok3 = sftpPath === '/home/logic/1221';
  console.log('\n=== 汇总 ===');
  console.log(`按钮禁用(无/Telnet): ${ok1 ? '✅' : '❌'}  按钮可用(SSH): ${ok2 ? '✅' : '❌'}  定位当前目录: ${ok3 ? '✅' : '❌'}`);

  // 清理
  try {
    await page.evaluate(() => {
      const close = document.querySelector('.tab .t-close');
      if (close) close.click();
    });
    await sleep(300);
    await page.click('#btn-close-ok').catch(() => {});
    await sleep(300);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
