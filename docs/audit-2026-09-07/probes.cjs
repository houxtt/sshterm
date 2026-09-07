// Read-only product audit. Mock devices and disposable loopback services only.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { once, EventEmitter } = require('events');
const { PassThrough } = require('stream');
const ROOT = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const serverCode = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
const results = [];
const record = (id, evidence) => { results.push({ id, evidence }); console.log(JSON.stringify({ id, evidence })); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing section: ${start}`);
  return source.slice(a, b);
}
function context(code, bindings = {}) { const c = vm.createContext({ Buffer, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, ...bindings }); vm.runInContext(code, c); return c; }
async function listen(s) { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s.address().port; }
async function startService(badLog = false, extraEnv = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-audit-'));
  const dataDir = path.join(profile, '.sshterm'); fs.mkdirSync(dataDir);
  if (badLog) fs.writeFileSync(path.join(dataDir, 'session-logs'), 'deliberate mock I/O failure');
  const holder = net.createServer(); const port = await listen(holder); await new Promise(r => holder.close(r));
  const child = spawn(process.execPath, ['server/index.js', '--no-open', '--port', String(port)], {
    cwd: ROOT, env: { ...process.env, USERPROFILE: profile, HOME: profile, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/launcher-info`)).ok) break; } catch {} await sleep(50); }
  return { child, profile, port, token: fs.readFileSync(path.join(dataDir, 'token'), 'utf8'), output: () => output,
    async stop() { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } } };
}
async function socketFor(service) {
  const WS = require(path.join(ROOT, 'node_modules/ws'));
  const ws = new WS(`ws://127.0.0.1:${service.port}/?token=${service.token}&window=${'audit'.repeat(10)}`, { origin: `http://127.0.0.1:${service.port}` });
  ws.on('error', () => {}); await once(ws, 'open'); return ws;
}
async function main() {
  const { sanitizeSession } = require(path.join(ROOT, 'server/session-schema'));
  record('SAVE_SERIAL', sanitizeSession({ type: 'serial', name: 'audit', port: 'COM27', port2: 'COM27', rtscts: true, hexMode: true, timestamp: true, trigger: 'ready', group: 'boards' }));
  record('SAVE_AUTH', sanitizeSession({ type: 'ssh', name: 'audit', host: 'target', autoCmds: ['echo ready'], proxy: { type: 'socks5', host: 'proxy', port: 1080, username: 'audit', password: 'fake' }, jumpAuth: { username: 'jump-user', auth: 'key', privateKey: 'fake-path' } }));
  const enc = require(path.join(ROOT, 'server/encoding'));
  record('LOG_SPLIT', { gbk: enc.decodeBuffer(Buffer.from([0xd6]), 'gbk') + enc.decodeBuffer(Buffer.from([0xd0]), 'gbk'), utf8: enc.decodeBuffer(Buffer.from([0xe4, 0xb8]), 'utf-8') + enc.decodeBuffer(Buffer.from([0xad]), 'utf-8') });
  const sent = [];
  const { encodeText } = require(path.join(ROOT, 'server/encoding'));
  const input = context(section(app, 'function sendInput(', '\nfunction showMfaDialog'), {
    WebSocket: { OPEN: 1, CONNECTING: 0 },
    ws: { readyState: 1, send: f => sent.push(Buffer.from(f).toString('hex')) },
    tabs: [{ id: 1, cfg: { encoding: 'gbk' } }],
    Enc: () => ({ encodeText: (s, enc) => encodeText(s, enc) }),
    hexdumpLine: () => '',
  });
  input.sendInput(1, '中', 'gbk'); record('GBK_INPUT', { actualFrame: sent[0], expectedFrame: '0100d6d0' });
  const tab = { id: 1, state: 'connected', cfg: {}, recParts: ['OLD_SUCCESS'], _outputSeq: 0 };
  const beforeSeq = tab._outputSeq || 0;
  const re = /OLD_SUCCESS/;
  const text = (tab.recParts || []).slice(-20).join('');
  const staleMatch = (tab._outputSeq || 0) > beforeSeq && re.test(text);
  record('SCRIPT_OLD_OUTPUT', { staleMatch, blocked: !staleMatch });
  const up = context(section(app, 'async function uploadFileSmart(', '// Non-Chromium'), {
    apiUrl: () => '',
    remoteSize: async () => ({ size: 3, mtime: 0, status: 200 }),
    remoteChecksum: async () => 'abc',
    sha256File: async () => 'abc',
    xhrUpload: async () => { throw Error('should not be reached'); },
  });
  record('UPLOAD_SAME_SIZE', await up.uploadFileSmart(1, '/', 'config', { size: 3 }, () => {}));
  const telnet = new (require(path.join(ROOT, 'server/connections/telnet')))({});
  const writes = []; telnet.state = 'connected'; telnet.sock = { write: b => writes.push([...Buffer.from(b)]) };
  telnet._sendNaws(255, 24); telnet.write(Buffer.from([255])); telnet._onData(Buffer.from([255,251,1]));
  record('TELNET_WIRE', { naws: writes[0], rawFF: writes[1], echoReply: writes[2] });
  const importer = require(path.join(ROOT, 'server/session-backup'));
  record('OPENSSH_MATCH', importer.parseOpenSSHConfig('Host app\n HostName app.internal\n User normal\nMatch user admin\n User root\n'));
  const { createParallelReadStream, receiveParallelUpload } = require(path.join(ROOT, 'server/sftp-transfer'));
  let readCalls = 0, firstRead;
  const sf = { open: (_, __, cb) => setImmediate(() => cb(null, Buffer.from('h'))), close: (_, cb) => cb(), read: (h,b,o,l,pos,cb) => { readCalls++; if (pos === 0) firstRead = () => cb(null,l); else setImmediate(() => cb(null,l)); } };
  const rs = createParallelReadStream(sf, 'fake', { end: 1024 * 100 - 1, chunkSize: 1024, concurrency: 2 }); rs.on('error', () => {}); rs.resume(); await sleep(80);
  record('SFTP_REORDER_BUFFER', { readCalls, bufferedChunks: rs.results.size, configuredConcurrency: 2 }); rs.destroy();
  let openCb, closedHandles = 0;
  const late = createParallelReadStream({ open: (_,__,cb) => { openCb = cb; }, close: (_,cb) => { closedHandles++; cb(); } }, 'fake', { end: 10 });
  late.destroy(); openCb(null, Buffer.from('late')); await sleep(5); record('SFTP_CANCEL_OPEN', { closedHandles, handleStillPresent: !!late.handle });
  const req = new PassThrough();
  const upload = receiveParallelUpload(req, { open: (p,f,m,cb) => cb(null, Buffer.from('h')), write: (h,b,o,l,p,cb) => cb(), close: (_,cb) => cb(new Error('remote flush failed')) }, 'fake');
  req.end('test');
  try {
    record('UPLOAD_CLOSE_ERROR', await upload.promise);
  } catch (e) {
    record('UPLOAD_CLOSE_ERROR', { rejected: true, message: e.message });
  }
  const serialCode = fs.readFileSync(path.join(ROOT, 'server/connections/serial.js'), 'utf8');
  let releaseOpen;
  class FakeSerial extends EventEmitter { constructor() { super(); this.isOpen = false; } open(cb) { releaseOpen = () => { this.isOpen = true; cb(); }; } close(cb) { this.isOpen = false; if(cb) cb(); } }
  const serialCtx = context(serialCode, { module: { exports: {} }, process, require: n => n === 'serialport' ? { SerialPort: FakeSerial } : require(path.join(ROOT,'server/connections/base')) });
  const serial = new serialCtx.module.exports({port:'COM27'}); serial.on('error',()=>{}); const connecting = serial.connect(); serial.close(); releaseOpen(); await connecting;
  record('SERIAL_CANCEL_CONNECT', { state: serial.state, deviceOpen: serial.sp.isOpen });
  const SSH = require(path.join(ROOT,'server/connections/ssh'));
  const ssh = new SSH({}); const fakeClient = new EventEmitter(); fakeClient.forwardIn = (h,p,cb) => cb(); ssh.client = fakeClient;
  await ssh.addTunnel({ type:'remote',localPort:1,remoteHost:'localhost',remotePort:10001 });
  await ssh.addTunnel({ type:'remote',localPort:2,remoteHost:'localhost',remotePort:10002 });
  let rejected = 0; const handlers = fakeClient.listeners('tcp connection'); handlers[0]({destPort:10002},()=>{},()=>rejected++);
  record('REMOTE_TUNNEL_DISPATCH', { unrelatedListenerRejects: rejected });
  const live = await startService();
  try {
    const puppeteer = require(path.join(ROOT, 'node_modules/puppeteer-core'));
    const executablePath = require(path.join(ROOT,'tests/browser_path'))(ROOT);
    const browser = await puppeteer.launch({ executablePath, headless: true, args:['--no-sandbox','--disable-gpu'], userDataDir: path.join(live.profile,'browser') });
    try {
      const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${live.port}/`); await page.waitForFunction(() => typeof newTab === 'function' && ws && ws.readyState === 1);
      record('BROWSER_SENTRY', await page.evaluate(async () => {
        const t = newTab({type:'serial',name:'audit',encoding:'gbk',hexMode:true},{connect:false});
        t.recording = { events:[],startedAt:Date.now(),size:0 }; t.logging = true;
        const frame = new Uint8Array([t.id & 255,t.id >> 8,65,66,67]); ws.onmessage({data:frame.buffer}); await new Promise(r=>setTimeout(r,80));
        return { sentry:!!t.zmodemSentry, recorded:t.recording.events.length, cached:t.recLen, captured:(t.captureParts||[]).length, screen:t.term.buffer.active.getLine(0).translateToString(true) };
      }));
      record('BROWSER_IMAGE_API', await page.evaluate(() => { const t = newTab({type:'ssh',name:'image'},{connect:false}); return {addon:!!t.imageAddon,registerImage:typeof t.imageAddon?.registerImage}; }));
      record('BROWSER_ERROR_STATE', await page.evaluate(() => { const t=tabs[0];t.state='connected';handleMsg({type:'error',id:t.id,msg:'SFTP: permission denied'});return t.state; }));
      record('BROWSER_SPLIT', await page.evaluate(() => {
        const t=tabs.find(t=>t.cfg.type==='ssh'); const old=send; send=()=>{};
        try { addPane(t); addPane(t); return {panes:t.extraPanes.length+1,error:null}; } catch(e){return {panes:t.extraPanes.length+1,error:e.message};}finally{send=old;}
      }));
    } finally { await browser.close(); }
  } finally { await live.stop(); }
  for (const kind of ['null', 'oversize', 'log-error']) {
    const service = await startService(kind === 'log-error'); let remote;
    try {
      const ws = await socketFor(service);
      if(kind === 'null') ws.send('null');
      if(kind === 'oversize') ws.send(Buffer.alloc(8*1024*1024+1));
      if(kind === 'log-error') { remote=net.createServer(s=>{s.on('error',()=>{});s.unref();}); const port=await listen(remote); ws.send(JSON.stringify({type:'connect',id:1,session:{type:'telnet',name:'audit',host:'127.0.0.1',port}})); }
      for(let i=0;i<40&&service.child.exitCode===null;i++) await sleep(50);
      record('SERVICE_'+kind.toUpperCase(), {exitCode:service.child.exitCode,error:service.output().slice(-1300)}); ws.terminate();
    } finally { await service.stop(); if(remote) remote.close(); }
  }
}
module.exports = { ROOT, app, serverCode, section, context, listen, startService, socketFor, sleep };
if (require.main === module) main().catch(e=>{ record('PROBE_ERROR',e.stack);process.exitCode=1; }).finally(()=>fs.writeFileSync(path.join(__dirname,'probe-results.json'),JSON.stringify(results,null,2)+'\n'));
