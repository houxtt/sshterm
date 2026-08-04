// 诊断: 页面 JS 状态 (为什么点新建对话框不弹)
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  const failed = [];
  page.on('requestfailed', r => failed.push(`${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', e => console.log('❌ pageerror:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('❌ console.error:', m.text().slice(0, 150)); });

  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 800));

  const diag = await page.evaluate(() => {
    const out = {};
    out.Terminal = typeof Terminal;
    out.FitAddon = typeof FitAddon;
    out.openDlg = typeof openDlg;
    out.newTab = typeof newTab;
    out.send = typeof send;
    out.btnNew = !!document.getElementById('btn-new');
    out.btnNewOnclick = !!document.getElementById('btn-new').onclick;
    out.dlgMask = !!document.getElementById('dlg-mask');
    out.dlgClass = document.getElementById('dlg-mask').className;
    // 手动调用 openDlg 看是否异常
    try { openDlg(); out.manualOpenDlg = 'ok'; } catch (e) { out.manualOpenDlg = '异常: ' + e.message; }
    out.dlgClassAfter = document.getElementById('dlg-mask').className;
    return out;
  });
  console.log('=== 页面 JS 诊断 ===');
  for (const [k, v] of Object.entries(diag)) console.log(`  ${k}: ${v}`);
  console.log('=== 失败资源 ===');
  console.log(failed.length ? failed.join('\n') : '(无)');
  await browser.close();
})();
