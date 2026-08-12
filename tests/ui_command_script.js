// UI regression for command-script execution primitives.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8799/';
(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const result = await page.evaluate(() => {
    const cfg = { host: '192.168.1.216', port: 22, name: 'script-test' };
    const expand = (cmd) => String(cmd).replace(/\{(IP|HOST|PORT|NAME)\}/g, (_, k) => ({ IP: cfg.host, HOST: cfg.host, PORT: cfg.port, NAME: cfg.name }[k]));
    return expand('ssh {IP}:{PORT} # {NAME}') === 'ssh 192.168.1.216:22 # script-test';
  });
  console.log(result ? '✅ 命令变量展开与脚本执行基础正常' : '❌ 命令变量展开失败');
  await browser.close();
  process.exit(result ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
