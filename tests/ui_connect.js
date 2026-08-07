// UI 功能测试 v2: 完整用户路径 (真实鼠标点击)
// 路径1: 新建 → 填 SSH → 连接 → shell
// 路径2: 保存并连接 → 会话入列表
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fillSshForm(page) {
  await page.type('#f-name', 'UI测试-SSH');
  await page.select('#f-type', 'ssh');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());   // 自动接受 confirm
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 0. 验证工具栏按钮可点 (CSS 修复验证)
  console.log('[0] 点工具栏"＋ 新建连接" (验证 welcome 不再遮挡)...');
  await page.click('#btn-new');
  await sleep(300);
  let dlgOpen = await page.$eval('#dlg-mask', el => !el.classList.contains('hidden'));
  console.log('    对话框弹出:', dlgOpen);
  if (!dlgOpen) { console.log('❌ 工具栏按钮仍被遮挡'); await browser.close(); process.exit(1); }

  // 1. 填表 + 点"连接"
  console.log('[1] 填写 SSH 并点"连接"...');
  await fillSshForm(page);
  await page.click('#btn-dlg-conn');
  await sleep(2000);

  const s1 = await page.evaluate(() => ({
    dlgHidden: document.getElementById('dlg-mask').classList.contains('hidden'),
    tabCount: document.querySelectorAll('.tab').length,
    welcomeHidden: document.getElementById('welcome').classList.contains('hidden'),
    dot: document.querySelector('.tab.active .t-state')?.textContent,
    termText: document.querySelector('.term-host:not(.hidden) .xterm-rows')?.textContent.slice(-200) || '(无)',
    hasFocus: !!document.querySelector('.xterm textarea:focus'),
  }));
  console.log('    对话框关闭:', s1.dlgHidden, '| 标签数:', s1.tabCount, '| 欢迎页隐藏:', s1.welcomeHidden);
  console.log('    状态点:', s1.dot, '| 终端焦点:', s1.hasFocus);
  console.log('    终端尾部:', JSON.stringify(s1.termText));

  let pass = s1.dlgHidden && s1.tabCount === 1 && s1.welcomeHidden && s1.hasFocus &&
             /[$#]\s*$/.test(s1.termText) && s1.dot === '🟢';
  if (!pass) {
    console.log('\n❌ 路径1(连接)失败. JS 错误:', errors.join(' | ') || '(无)');
  } else {
    console.log('✅ 路径1(连接): 对话框关闭 → 标签激活 → shell 就绪');
  }

  // 2. 关闭标签 (走确认框), 再测"保存并连接"
  await page.click('.tab .t-close');
  await sleep(300);
  await page.click('#btn-close-ok');   // 确认关闭
  await sleep(500);
  console.log('\n[2] 新建 → 填 SSH → 点"保存并连接"...');
  await page.click('#btn-new');
  await sleep(300);
  await fillSshForm(page);
  await page.click('#btn-dlg-save');
  await sleep(2000);

  const s2 = await page.evaluate(() => ({
    dlgHidden: document.getElementById('dlg-mask').classList.contains('hidden'),
    tabCount: document.querySelectorAll('.tab').length,
    sessionCount: document.querySelectorAll('#session-list li').length,
    listHas: Array.from(document.querySelectorAll('#session-list li')).some(li => li.textContent.includes('UI测试-SSH')),
    termText: document.querySelector('.term-host:not(.hidden) .xterm-rows')?.textContent.slice(-150) || '(无)',
  }));
  console.log('    对话框关闭:', s2.dlgHidden, '| 标签数:', s2.tabCount, '| 会话列表项:', s2.sessionCount, '| 含保存项:', s2.listHas);
  console.log('    终端尾部:', JSON.stringify(s2.termText));

  const pass2 = s2.dlgHidden && s2.tabCount === 1 && s2.listHas && /[$#]\s*$/.test(s2.termText);
  console.log(pass2 ? '✅ 路径2(保存并连接): 连接 + 会话已保存' : '❌ 路径2 失败. JS 错误:', errors.join(' | ') || '(无)');

  console.log('\n=== 汇总 ===');
  console.log(`路径1(连接): ${pass ? '✅' : '❌'}  路径2(保存并连接): ${pass2 ? '✅' : '❌'}  JS错误: ${errors.length}`);
  // 清理测试会话
  await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll('#session-list li')).find(l => l.textContent.includes('UI测试-SSH'));
    if (li) li.querySelector('[data-act=del]').click();
  });
  await sleep(500);
  try { browser.process() && browser.process().kill(); } catch (e) { /* 忽略 */ }
  process.exit(pass && pass2 ? 0 : 1);
}
main().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
