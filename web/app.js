// sshterm 前端: 多标签终端 + 会话管理
/* global Terminal, WebSocket */

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);
const hexOf = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
const esc = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// FitAddon 兼容: UMD 可能是 { FitAddon: class } 命名空间
const FitAddonCtor = (typeof FitAddon === 'function') ? FitAddon
  : (window.FitAddon && window.FitAddon.FitAddon);
if (typeof Terminal !== 'function' || !FitAddonCtor) {
  document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif;color:#f87171">' +
    '❌ 终端核心加载失败(xterm.js / addon-fit), 请刷新或检查服务端资源。</div>';
  throw new Error('terminal core missing');
}

const TYPE_ICON = { ssh: '🖥️', telnet: '🔌', serial: '🔗' };
const STATE_TEXT = { connecting: '连接中…', connected: '● 已连接', closed: '✕ 已断开' };

// ---------- 全局状态 ----------
const ws = new WebSocket(`ws://${location.host}`);
let tabs = [];            // {id, cfg, term, host, state, hex}
let tabSeq = 1;
let activeTabId = null;
let sessions = [];        // 已保存会话列表
let editingId = null;     // 对话框正在编辑的会话 id
let serialPorts = [];

// ---------- WS 连接 ----------
ws.binaryType = 'arraybuffer';
ws.onopen = () => {
  $('conn-status').className = 'status-dot ok';
  $('conn-status-text').textContent = '服务器已连接';
  send({ type: 'cleanup' });      // 兜底清理刷新残留的连接
  send({ type: 'list' });
  send({ type: 'serialports' });
  restoreTabs();                  // 恢复刷新前打开的会话 (重新连接)
};
ws.onclose = () => {
  $('conn-status').className = 'status-dot err';
  $('conn-status-text').textContent = '服务器已断开';
  for (const t of tabs) setTabState(t.id, 'closed', '服务器断开');
};
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') return handleMsg(JSON.parse(ev.data));
  // binary: [tabId: 2B LE][data]
  const buf = new Uint8Array(ev.data);
  const id = buf[0] | (buf[1] << 8);
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  const payload = buf.subarray(2);
  if (tab.hex) tab.term.write(hexOf(payload) + ' ');
  else tab.term.write(payload);
  // 累积终端内容 (数组 push, 避免高频输出时的字符串拼接卡顿)
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
    if (!tab.recParts) tab.recParts = [];
    tab.recLen = (tab.recLen || 0) + text.length;
    tab.recParts.push(text);
    while (tab.recLen > BUF_MAX && tab.recParts.length) {
      tab.recLen -= tab.recParts.shift().length;
    }
  } catch (e) { /* 忽略 */ }
};
function send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function log(msg) { send({ type: 'log', msg }); }
function sendInput(tabId, str) {
  const bytes = new TextEncoder().encode(str);
  const frame = new Uint8Array(2 + bytes.length);
  frame[0] = tabId & 0xff; frame[1] = (tabId >> 8) & 0xff;
  frame.set(bytes, 2);
  if (ws.readyState === 1) ws.send(frame);
}

function handleMsg(m) {
  switch (m.type) {
    case 'sessions': {
      sessions = m.list || [];
      renderSessionList();
      break;
    }
    case 'status': {
      const tab = tabs.find(t => t.id === m.id);
      if (tab) {
        setTabState(m.id, m.state, m.msg);
        if (m.state === 'connected') {
          tab.cfg._serverCfg = m.cfg;
          fitTerm(tab);
        }
      }
      break;
    }
    case 'error': {
      sftpBusy = false;                 // SFTP 加载失败也释放锁
      const tab = tabs.find(t => t.id === m.id);
      const where = tab ? tab : { term: null };
      if (tab) { tab.term.writeln(`\r\n\x1b[31m[错误] ${m.msg}\x1b[0m`); setTabState(tab.id, 'closed', '出错'); }
      else setStatus(`错误: ${m.msg}`);
      break;
    }
    case 'reuse': {
      const tab = tabs.find(t => t.id === m.id);
      if (tab) { tab.term.writeln('\r\n\x1b[33m[提示] 相同配置的连接已存在, 复用中\x1b[0m'); }
      break;
    }
    case 'serialports': {
      serialPorts = m.list || [];
      fillSerialPorts();
      break;
    }
    case 'logs': {
      renderLogs(m.list || []);
      break;
    }
    case 'sftp': {
      if (m.id !== sftpConnId) break;
      if (m.action === 'cwd') {
        // 定位到 shell 当前目录 (cwd 失败则回退 home)
        sftpBusy = false;
        if (m.path) sftpPath = m.path;
        sftpLoad();
      } else if (m.action === 'list') {
        sftpBusy = false;
        sftpPath = m.path;              // 服务端 realpath 后的绝对路径
        $('sftp-path').value = m.path;
        renderSftpList(m.entries);
      }
      break;
    }
  }
}

// ---------- 标签持久化 (刷新页面自动恢复打开的会话 + 终端内容) ----------
const LS_TABS = 'sshterm.tabs';
const BUF_MAX = 200 * 1024;   // 每标签保留最近 200KB 输出, 刷新后重放
function saveTabs() {
  try {
    localStorage.setItem(LS_TABS, JSON.stringify(tabs.map(t => ({
      cfg: t.cfg, hex: !!t.hex, buf: (t.recParts || []).join(''),
    }))));
  } catch (e) { /* 存储失败忽略 */ }
}
function restoreTabs() {
  try {
    const raw = localStorage.getItem(LS_TABS);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && item.cfg && item.cfg.type) {
        newTab(item.cfg, { connect: true, hex: item.hex, replay: item.buf });
      }
    }
    setStatus(`已恢复 ${list.length} 个会话`);
  } catch (e) { /* 解析失败忽略 */ }
}
// 刷新/关闭页面前保存最新终端内容
window.addEventListener('beforeunload', () => saveTabs());

// ---------- 标签管理 ----------
function newTab(cfg, opts = {}) {
  const id = tabSeq++;
  const host = document.createElement('div');
  host.className = 'term-host';
  $('terms').appendChild(host);

  const term = new Terminal({
    fontSize: 13, fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: true, scrollback: 5000,
    theme: { background: '#1a1b26', foreground: '#c0caf5' },
  });
  const fitAddon = new (FitAddonCtor)();
  term.loadAddon(fitAddon);
  term.open(host);
  setTimeout(() => fitAddon.fit(), 0);

  const tab = { id, cfg, term, host, state: 'idle', hex: !!(opts.hex ?? cfg.hexMode), fitAddon, recParts: [], recLen: 0 };
  tabs.push(tab);
  renderTabbar();
  activateTab(id);
  bindClipboard(tab);
  saveTabs();

  // 刷新恢复: 先重放之前的终端内容, 再建立连接
  if (opts.replay) {
    tab.recParts = [opts.replay];
    tab.recLen = opts.replay.length;
    try {
      term.write(opts.replay);
      term.write('\r\n\x1b[33m[--- 连接已重新建立 ---]\x1b[0m\r\n');
    } catch (e) { /* 忽略 */ }
  }

  term.onData((d) => sendInput(id, d));
  term.onResize(({ cols, rows }) => send({ type: 'resize', id, cols, rows }));

  // 窗口尺寸变化 → 重新适配
  const ro = new ResizeObserver(() => { if (activeTabId === id) fitTerm(tab); });
  ro.observe(host);

  if (opts.connect !== false) {
    setTabState(id, 'connecting', '连接中…');
    send({ type: 'connect', session: cfg, id });
  }
  return tab;
}

function fitTerm(tab) {
  try { tab.fitAddon.fit(); } catch (e) { /* 忽略 */ }
}

// ---------- 复制粘贴 (Xshell 习惯, 防剪贴板竞争卡死) ----------
const COPY_MAX = 512 * 1024;   // 单次复制上限 512KB
let _lastCopyAt = 0;
let _clipBusy = false;         // 剪贴板操作互斥锁: 一次只允许一个, 防并发竞争死锁

function copySelection(term) {
  const sel = term.getSelection();
  if (!sel || _clipBusy) return false;
  _clipBusy = true;
  const toCopy = sel.length > COPY_MAX ? sel.slice(0, COPY_MAX) : sel;
  // 失败/超时静默处理: 不弹提示不重试 (系统剪贴板被其他程序锁定时快速放弃)
  const timer = setTimeout(() => { _clipBusy = false; }, 800);
  navigator.clipboard.writeText(toCopy).then(
    () => { clearTimeout(timer); _clipBusy = false; },
    () => { clearTimeout(timer); _clipBusy = false; });
  return true;
}
function pasteClipboard(term) {
  if (_clipBusy) return;
  _clipBusy = true;
  const timer = setTimeout(() => {
    _clipBusy = false;
    setStatus('剪贴板读取超时, 可用 Ctrl+Shift+V 粘贴');
  }, 1500);
  navigator.clipboard.readText().then(
    (t) => { clearTimeout(timer); _clipBusy = false; if (t) term.paste(t); },
    () => { clearTimeout(timer); _clipBusy = false; setStatus('剪贴板读取被拒, 可用 Ctrl+Shift+V 粘贴'); });
}
function bindClipboard(tab) {
  const { term, host } = tab;

  // 1. 鼠标左键选中文本 → 自动复制
  // 点击风暴防护: ①clearTimeout 合并定时器 ②1 秒内点击超阈值进入防风暴模式, 完全停用复制
  let _stormCount = 0;
  let _stormUntil = 0;
  const inStorm = () => Date.now() < _stormUntil;
  const markClick = () => {
    const now = Date.now();
    if (now > _stormUntil) {
      _stormCount = (now - _stormUntil > 1000) ? 1 : _stormCount + 1;
      if (_stormCount > 12) {           // 1 秒内超过 12 次 = 风暴
        _stormUntil = now + 3000;       // 防风暴 3 秒: 完全不碰选择/剪贴板
        _stormCount = 0;
      }
    }
    return inStorm();
  };
  host.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (markClick()) return;            // 风暴中: 直接忽略, 不产生任何定时器
    clearTimeout(tab._copyTimer);
    tab._copyTimer = setTimeout(() => {
      try {
        const sel = term.getSelection();
        if (sel) copySelection(term);
      } catch (err) { /* 忽略 */ }
    }, 300);
  });

  // 2. 右键: 有选中文本 → 复制; 无选中 → 不碰剪贴板 (readText 权限气泡模态会阻塞页面)
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (inStorm()) return;              // 风暴中: 右键也不碰选择/剪贴板
    // 清掉 xterm 右键时灌入隐藏 textarea 的选中文本, 消除 DOM 选择与剪贴板操作竞争
    try { if (term.textarea) term.textarea.value = ''; } catch (err) { /* 忽略 */ }
    if (term.getSelection()) {
      copySelection(term);
      term.clearSelection();        // 复制后清空选择, 避免重复触发
    }
    // 无选中时不做任何剪贴板操作 (粘贴请用 Ctrl+Shift+V / Ctrl+V)
  });

  // 3. 快捷键 (Ctrl/⌘ + C/V, Ctrl+Shift+C/V)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && k === 'c') {
      if (term.getSelection()) { copySelection(term); return false; }  // 有选中→复制
      return true;                                                     // 无选中→SIGINT 照常
    }
    if (mod && !e.shiftKey && k === 'v') { pasteClipboard(term); return false; }
    if (mod && e.shiftKey && k === 'c') { copySelection(term); return false; }
    if (mod && e.shiftKey && k === 'v') { pasteClipboard(term); return false; }
    return true;
  });
}

// ---------- 关闭会话 (活跃连接需确认) ----------
let pendingCloseId = null;

function requestCloseTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  // 空闲/已断开的直接关, 活跃连接必须确认
  if (tab.state !== 'connected' && tab.state !== 'connecting') {
    doCloseTab(id);
    return;
  }
  pendingCloseId = id;
  const typeName = TYPE_ICON[tab.cfg.type] || '';
  const target = tab.cfg.host || tab.cfg.port || '';
  $('close-info').innerHTML =
    `${typeName} 将断开连接 <b>${esc(tab.cfg.name || '未命名')}</b>${target ? ` (${esc(target)})` : ''}，<br>该操作会立即关闭会话。`;
  $('dlg-close-mask').classList.remove('hidden');
}

function doCloseTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  send({ type: 'disconnect', id });
  const [tab] = tabs.splice(idx, 1);
  try { tab.term.dispose(); } catch (e) {}
  tab.host.remove();
  if (activeTabId === id) activeTabId = null;
  const next = tabs[idx] || tabs[idx - 1];
  if (next) activateTab(next.id);
  renderTabbar();
  updateWelcome();
  updateSftpBtn();
  saveTabs();
  log(`关闭会话「${tab.cfg.name || id}」`);
}

function activateTab(id) {
  activeTabId = id;
  for (const t of tabs) {
    t.host.classList.toggle('hidden', t.id !== id);
    if (t.id === id) setTimeout(() => { fitTerm(t); t.term.focus(); }, 0);
  }
  renderTabbar();
  updateWelcome();
  updateSftpBtn();
}

function setTabState(id, state, msg) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  tab.state = state;
  tab.stateMsg = msg;
  renderTabbar();
  updateSftpBtn();
  if (state === 'closed' && msg) setStatus(msg);
}

function renderTabbar() {
  const bar = $('tabbar');
  bar.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    const dot = t.state === 'connected' ? '🟢' : t.state === 'connecting' ? '🟡' : '🔴';
    el.innerHTML = `
      <span class="t-state" title="${esc(t.stateMsg || '')}">${dot}</span>
      <span class="t-name">${esc(t.cfg.name || (TYPE_ICON[t.cfg.type] + ' ' + (t.cfg.host || t.cfg.port)))}</span>
      <span class="t-close">✕</span>`;
    el.querySelector('.t-close').onclick = (e) => { e.stopPropagation(); requestCloseTab(t.id); };
    el.onclick = () => activateTab(t.id);
    el.onauxclick = (e) => { if (e.button === 1) requestCloseTab(t.id); };
    bar.appendChild(el);
  }
  if (!tabs.length) $('tabbar').innerHTML = '<span class="muted" style="padding:8px 12px">无连接 — 双击左侧会话或新建</span>';
}

function updateWelcome() { $('welcome').classList.toggle('hidden', tabs.length > 0); }

// ---------- 会话列表 ----------
let batchMode = false;
const batchSel = new Set();

function renderSessionList() {
  const ul = $('session-list');
  ul.innerHTML = '';
  if (!sessions.length) {
    ul.innerHTML = '<li class="muted" style="cursor:default">(还没有保存的会话)</li>';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    const sub = s.type === 'serial' ? `${s.port} @ ${s.baudRate}` : `${s.host}:${s.port}`;
    const checked = batchSel.has(s.id) ? 'checked' : '';
    li.innerHTML = `
      ${batchMode ? `<input type="checkbox" class="b-cb" data-id="${esc(s.id)}" ${checked}>` : ''}
      <span class="type-icon">${TYPE_ICON[s.type] || '❔'}</span>
      <span class="s-name">${esc(s.name)}</span>
      <span class="s-sub">${esc(sub)}</span>
      <span class="s-ops">
        <button title="编辑" data-act="edit">✏️</button>
        <button title="删除" data-act="del" class="danger">🗑</button>
      </span>`;
    li.ondblclick = () => { if (!batchMode) connectTo(s); };
    li.querySelector('.b-cb')?.addEventListener('change', (e) => {
      if (e.target.checked) batchSel.add(s.id); else batchSel.delete(s.id);
      updateBatchBar();
    });
    li.querySelector('[data-act=edit]').onclick = (e) => {
      e.stopPropagation();
      if (batchMode) return;
      openDlg(s);
    };
    li.querySelector('[data-act=del]').onclick = (e) => {
      e.stopPropagation();
      if (batchMode) return;
      if (confirm(`删除会话「${s.name}」?`)) send({ type: 'delete', id: s.id });
    };
    ul.appendChild(li);
  }
}

function updateBatchBar() {
  $('batch-n').textContent = batchSel.size;
  $('batch-del').disabled = batchSel.size === 0;
}
function setBatchMode(on) {
  batchMode = on;
  batchSel.clear();
  $('batch-bar').classList.toggle('hidden', !on);
  $('btn-batch').textContent = on ? '✕ 退出' : '☑ 批量';
  updateBatchBar();
  renderSessionList();
}

// 连接防抖: 连续点击/双击只触发一次, 防止疯狂开新连接卡死页面
let _lastConnAt = 0;
function connectTo(s) {
  const now = Date.now();
  if (now - _lastConnAt < 600) return;
  _lastConnAt = now;
  newTab({ ...s });
}

// ---------- 新建/编辑对话框 ----------
function openDlg(existing = null) {
  editingId = existing ? existing.id : null;
  $('dlg-title').textContent = existing ? '编辑会话' : '新建连接';
  $('f-name').value = existing?.name || '';
  $('f-type').value = existing?.type || 'ssh';
  $('f-host').value = existing?.host || '';
  $('f-port').value = existing?.port || (existing?.type === 'telnet' ? 23 : 22);
  $('f-user').value = existing?.username || '';
  $('f-auth').value = existing?.auth || 'password';
  $('f-password').value = '';
  $('f-key').value = existing?.privateKey || '';
  $('f-passphrase').value = '';
  $('t-host').value = existing?.host || '';
  $('t-port').value = existing?.port || 23;
  $('t-autologin').checked = !!existing?.autoLogin;
  $('t-user').value = existing?.loginUser || '';
  $('t-pass').value = '';
  $('s-port').value = existing?.port2 || existing?.port || '';
  $('s-baud').value = String(existing?.baudRate || 115200);
  $('s-data').value = String(existing?.dataBits || 8);
  $('s-stop').value = String(existing?.stopBits || 1);
  $('s-parity').value = existing?.parity || 'none';
  $('s-hex').checked = !!existing?.hexMode;
  updateDlgFields();
  $('dlg-mask').classList.remove('hidden');
  $('f-name').focus();
}

function updateDlgFields() {
  const type = $('f-type').value;
  $('grp-ssh').classList.toggle('hidden', type !== 'ssh');
  $('grp-telnet').classList.toggle('hidden', type !== 'telnet');
  $('grp-serial').classList.toggle('hidden', type !== 'serial');
  const auth = $('f-auth').value;
  $('f-pwd-wrap').classList.toggle('hidden', auth !== 'password');
  $('f-key-wrap').classList.toggle('hidden', auth !== 'key');
  $('f-pass-wrap').classList.toggle('hidden', auth !== 'key');
  const auto = $('t-autologin').checked;
  $('t-user-wrap').classList.toggle('hidden', !auto);
  $('t-pass-wrap2').classList.toggle('hidden', !auto);
}

function collectDlg() {
  const type = $('f-type').value;
  const base = { id: editingId || undefined, name: $('f-name').value.trim(), type };
  if (type === 'ssh') {
    Object.assign(base, {
      host: $('f-host').value.trim(), port: parseInt($('f-port').value, 10) || 22,
      username: $('f-user').value.trim(), auth: $('f-auth').value,
      password: $('f-password').value || undefined,
      privateKey: $('f-key').value.trim() || undefined,
      passphrase: $('f-passphrase').value || undefined,
    });
  } else if (type === 'telnet') {
    Object.assign(base, {
      host: $('t-host').value.trim(), port: parseInt($('t-port').value, 10) || 23,
      autoLogin: $('t-autologin').checked,
      loginUser: $('t-user').value.trim() || undefined,
      loginPass: $('t-pass').value || undefined,
    });
  } else {
    Object.assign(base, {
      port2: $('s-port').value, port: $('s-port').value,
      baudRate: parseInt($('s-baud').value, 10) || 115200,
      dataBits: parseInt($('s-data').value, 10) || 8,
      stopBits: parseInt($('s-stop').value, 10) || 1,
      parity: $('s-parity').value, hexMode: $('s-hex').checked,
    });
  }
  return base;
}

function fillSerialPorts() {
  const sel = $('s-port');
  const cur = sel.value;
  sel.innerHTML = '';
  if (!serialPorts.length) {
    sel.innerHTML = '<option value="">(未发现串口)</option>';
  } else {
    for (const p of serialPorts) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.path + (p.manufacturer ? ` (${p.manufacturer})` : '');
      sel.appendChild(o);
    }
    if (serialPorts.some(p => p.path === cur)) sel.value = cur;
  }
}

// ---------- SFTP 文件面板 (SSH) ----------
let sftpOpen = false;
let sftpConnId = null;
let sftpPath = '.';
let sftpBusy = false;          // 加载锁: 防止双击/连点导致路径重复拼接

function fmtSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
  return (n / 1073741824).toFixed(2) + 'GB';
}

// 文件面板按钮可用性: 仅 SSH 已连接时可用
function updateSftpBtn() {
  const tab = tabs.find(t => t.id === activeTabId);
  const ok = !!(tab && tab.cfg.type === 'ssh' && tab.state === 'connected');
  $('btn-sftp').disabled = !ok;
  $('btn-sftp').title = ok ? 'SSH 文件浏览/下载 (SFTP)' : '文件面板仅 SSH 已连接时可用';
}

function toggleSftpPanel() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.cfg.type !== 'ssh') return setStatus('文件面板仅支持 SSH 会话');
  if (tab.state !== 'connected') return setStatus('SSH 未连接, 无法访问文件');
  sftpOpen = !sftpOpen;
  $('sftp-panel').classList.toggle('hidden', !sftpOpen);
  $('terms').classList.toggle('sftp-open', sftpOpen);
  if (sftpOpen) {
    sftpConnId = tab.id;
    sftpPath = '.';
    $('sftp-status').textContent = '定位当前目录…';
    // 先请求 shell 当前目录, 拿到后定位再列目录 (cwd 失败则默认 home)
    send({ type: 'sftp', id: sftpConnId, action: 'cwd' });
  }
}

function sftpLoad() {
  if (sftpBusy || !sftpConnId) return;   // 加载中忽略重复点击
  sftpBusy = true;
  $('sftp-path').value = sftpPath;
  $('sftp-status').textContent = '加载中…';
  send({ type: 'sftp', id: sftpConnId, action: 'list', path: sftpPath });
  // 超时兜底: 8 秒无响应释放锁
  setTimeout(() => { sftpBusy = false; }, 8000);
}

// 绝对路径拼接工具 (服务端返回 realpath 绝对路径)
function sftpJoin(dir, name) {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function renderSftpList(entries) {
  const el = $('sftp-list');
  el.innerHTML = '';
  $('sftp-status').textContent = `${entries.length} 项`;
  if (!entries.length) {
    el.innerHTML = '<div class="muted" style="padding:12px">(空目录)</div>';
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'sftp-item ' + (e.isDir ? 'dir' : 'file');
    const size = e.isDir ? '—' : fmtSize(e.size);
    const time = new Date(e.mtime).toLocaleString('zh-CN',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <span class="sftp-ico">${e.isDir ? '📁' : '📄'}</span>
      <span class="sftp-name" title="${esc(e.name)}">${esc(e.name)}</span>
      <span class="sftp-size">${size}</span>
      <span class="sftp-time">${time}</span>
      ${e.isDir
        ? '<button class="mini sftp-dl" title="打包下载整个目录 (zip)">📦</button>'
        : '<button class="mini sftp-dl" title="下载">⬇</button>'}`;
    row.onclick = () => {
      if (!e.isDir) return;
      sftpPath = sftpJoin(sftpPath, e.name);
      sftpLoad();
    };
    row.querySelector('.sftp-dl')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const full = sftpJoin(sftpPath, e.name);
      const url = e.isDir
        ? `/api/sftp/download-dir?conn=${sftpConnId}&path=${encodeURIComponent(full)}`
        : `/api/sftp/download?conn=${sftpConnId}&path=${encodeURIComponent(full)}`;
      const dlName = e.isDir ? e.name + '.zip' : e.name;
      showProgress(`下载: ${dlName} 准备中...`, 0);
      try {
        const blob = await xhrDownload(url, (loaded, total) => {
          if (total > 0) {
            showProgress(`下载: ${dlName} ${(loaded / total * 100).toFixed(0)}% (${fmtSize(loaded)}/${fmtSize(total)})`,
              loaded / total * 100);
          } else {
            showProgress(`下载: ${dlName} ${fmtSize(loaded)}`, undefined);
          }
        });
        if (blob && blob.size > 0) {
          saveBlob(blob, dlName);
          doneProgress(`✅ 已下载: ${dlName} (${fmtSize(blob.size)})`);
        } else {
          throw new Error('响应为空');
        }
      } catch (err) {
        $('sftp-progress').classList.add('hidden');
        $('sftp-status').textContent = `下载失败: ${err.message}`;
      }
    });
    el.appendChild(row);
  }
}

// ---------- 操作日志面板 ----------
function openLogPanel() {
  $('dlg-log-mask').classList.remove('hidden');
  send({ type: 'logs' });
}
function renderLogs(list) {
  const el = $('log-list');
  el.innerHTML = list.length
    ? list.map(l => `<div class="log-line ${l.level === 'error' ? 'log-err' : ''}">
        <span class="log-t">${esc(l.t)}</span>
        <span class="log-lv">[${esc(l.level)}]</span>
        <span class="log-msg">${esc(l.msg)}</span></div>`).join('')
    : '<div class="muted">(暂无日志)</div>';
  el.scrollTop = el.scrollHeight;
}

// ---------- 事件绑定 ----------
$('btn-new').onclick = () => openDlg();
$('btn-welcome-new').onclick = () => openDlg();
$('btn-save').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的连接可保存');
  openDlg(tab.cfg);
};
$('btn-log').onclick = openLogPanel;
$('log-close').onclick = () => $('dlg-log-mask').classList.add('hidden');
$('btn-sftp').onclick = toggleSftpPanel;
$('btn-killall').onclick = () => {
  if (!tabs.length) return setStatus('没有打开的会话');
  if (!confirm(`断开全部 ${tabs.length} 个会话?`)) return;
  const n = tabs.length;
  for (const t of [...tabs]) doCloseTab(t.id);
  setStatus(`已断开 ${n} 个会话`);
};
$('sftp-close').onclick = () => { sftpOpen = false; $('sftp-panel').classList.add('hidden'); $('terms').classList.remove('sftp-open'); };
$('sftp-up').onclick = () => {
  if (sftpPath === '/' || sftpPath === '.') return;
  const idx = sftpPath.lastIndexOf('/');
  sftpPath = idx <= 0 ? '/' : sftpPath.slice(0, idx);
  sftpLoad();
};
$('sftp-refresh').onclick = sftpLoad;
// ---------- SFTP 传输 (XHR + 进度条, 大文件不卡页面) ----------
let _progLast = 0;
function showProgress(text, pct) {
  const now = Date.now();
  if (now - _progLast < 80 && pct !== undefined && pct < 100) return;  // 节流 80ms
  _progLast = now;
  $('sftp-progress').classList.remove('hidden');
  $('sftp-progress-text').textContent = text;
  if (pct !== undefined) {
    $('sftp-progress-fill').style.width = Math.min(100, Math.round(pct)) + '%';
  }
}
function doneProgress(text) {
  _progLast = 0;
  $('sftp-progress-fill').classList.add('done');
  $('sftp-progress-fill').style.width = '100%';
  $('sftp-progress-text').textContent = text;
  setTimeout(() => {
    $('sftp-progress').classList.add('hidden');
    $('sftp-progress-fill').classList.remove('done');
    $('sftp-progress-fill').style.width = '0%';
  }, 2500);
}
// XHR 上传 (带进度) → resolve(status)
function xhrUpload(url, file, onProg) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProg) onProg(e.loaded, e.total);
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}
// XHR 下载 (带进度) → resolve(blob)
function xhrDownload(url, onProg) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => {
      if (onProg) onProg(e.loaded, e.lengthComputable ? e.total : 0);
    };
    xhr.onload = () => resolve(xhr.response);
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send();
  });
}
// Blob 触发浏览器保存
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// SFTP 上传: 选择本地文件 → XHR 上传到当前目录 (带进度条)
$('sftp-upload').onclick = () => $('sftp-file-input').click();
$('sftp-file-input').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = `/api/sftp/upload?conn=${sftpConnId}` +
    `&path=${encodeURIComponent(sftpPath)}&name=${encodeURIComponent(file.name)}`;
  showProgress(`上传: ${file.name} 0%`, 0);
  try {
    const status = await xhrUpload(url, file, (loaded, total) => {
      showProgress(`上传: ${file.name} ${(loaded / total * 100).toFixed(0)}%`, loaded / total * 100);
    });
    if (status !== 200) throw new Error('服务端返回 ' + status);
    doneProgress(`✅ 已上传: ${file.name}`);
    sftpLoad();
  } catch (err) {
    $('sftp-progress').classList.add('hidden');
    $('sftp-status').textContent = `上传失败: ${err.message}`;
  }
  e.target.value = '';
};

// SFTP 文件夹上传: XHR 逐个上传 (每个文件进度 + 总计)
$('sftp-upload-dir').onclick = () => $('sftp-dir-input').click();
$('sftp-dir-input').onchange = async (e) => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  const total = files.length;
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rel = f.webkitRelativePath || f.name;
    const url = `/api/sftp/upload?conn=${sftpConnId}` +
      `&path=${encodeURIComponent(sftpPath)}&name=${encodeURIComponent(rel)}`;
    try {
      const status = await xhrUpload(url, f, (loaded, ftotal) => {
        const pct = (i + loaded / ftotal) / total * 100;
        showProgress(`上传 ${i + 1}/${total}: ${rel} ${(loaded / ftotal * 100).toFixed(0)}%`, pct);
      });
      if (status === 200) ok++; else fail++;
    } catch (err) { fail++; }
  }
  doneProgress(`✅ 文件夹上传完成: ${ok}/${total} 成功${fail ? `, ${fail} 失败` : ''}`);
  sftpLoad();
  e.target.value = '';
};
$('btn-refresh').onclick = () => { send({ type: 'list' }); send({ type: 'serialports' }); };
$('s-refresh').onclick = () => send({ type: 'serialports' });
$('f-type').onchange = updateDlgFields;
$('f-auth').onchange = updateDlgFields;
$('t-autologin').onchange = updateDlgFields;
$('btn-dlg-cancel').onclick = () => $('dlg-mask').classList.add('hidden');

// 关闭确认
$('btn-close-ok').onclick = () => {
  if (pendingCloseId != null) doCloseTab(pendingCloseId);
  pendingCloseId = null;
  $('dlg-close-mask').classList.add('hidden');
};
$('btn-close-cancel').onclick = () => {
  pendingCloseId = null;
  $('dlg-close-mask').classList.add('hidden');
};
$('dlg-close-mask').addEventListener('click', (e) => {
  if (e.target === $('dlg-close-mask')) {   // 点遮罩 = 取消
    pendingCloseId = null;
    $('dlg-close-mask').classList.add('hidden');
  }
});

// 批量模式
$('btn-batch').onclick = () => setBatchMode(!batchMode);
$('batch-cancel').onclick = () => setBatchMode(false);
$('batch-all').onchange = (e) => {
  batchSel.clear();
  if (e.target.checked) for (const s of sessions) batchSel.add(s.id);
  updateBatchBar();
  renderSessionList();
};
$('batch-del').onclick = () => {
  if (!batchSel.size) return;
  const names = sessions.filter(s => batchSel.has(s.id)).map(s => `「${s.name}」`).join(' ');
  if (confirm(`删除 ${batchSel.size} 个会话? ${names}`)) {
    send({ type: 'deleteMany', ids: [...batchSel] });
    setBatchMode(false);
    log(`批量删除 ${batchSel.size} 个会话`);
  }
};

function doConnect(save) {
  const cfg = collectDlg();
  if (!cfg.name) { alert('请填写会话名称'); return; }
  if (save) send({ type: 'save', session: cfg });
  $('dlg-mask').classList.add('hidden');
  newTab(cfg);
}
$('btn-dlg-conn').onclick = () => doConnect(false);
$('btn-dlg-save').onclick = () => doConnect(true);

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openDlg(); }
});

function setStatus(msg) {
  $('sb-left').textContent = msg;
  $('statusbar').style.color = msg.startsWith('错误') ? '#ef4444' : '';
}
$('srv-addr').textContent = `localhost${location.port ? ':' + location.port : ''}`;

// 初始欢迎
updateWelcome();
updateSftpBtn();
