// sshterm 前端: 多标签终端 + 会话管理
/* global Terminal, WebSocket */

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);
const hexOf = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
const esc = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// FitAddon/SearchAddon 兼容: UMD 可能是 { Xxx: class } 命名空间
const FitAddonCtor = (typeof FitAddon === 'function') ? FitAddon
  : (window.FitAddon && window.FitAddon.FitAddon);
const SearchAddonCtor = (typeof SearchAddon === 'function') ? SearchAddon
  : (window.SearchAddon && window.SearchAddon.SearchAddon);
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
  // binary: [connId: 2B LE][data] → 找对应标签/pane
  const buf = new Uint8Array(ev.data);
  const id = buf[0] | (buf[1] << 8);
  let tab = tabs.find(t => t.id === id);
  let pane = null;
  if (!tab) {
    for (const t of tabs) {
      const p = (t.extraPanes || []).find(x => x.connId === id);
      if (p) { tab = t; pane = p; break; }
    }
  }
  if (!tab) return;
  const term = pane ? pane.term : tab.term;
  const payload = buf.subarray(2);
  if ((pane ? pane.hex : tab.hex)) term.write(hexOf(payload) + ' ');
  else term.write(payload);
  // 累积终端内容 (数组 push, 避免高频输出时的字符串拼接卡顿)
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
    const target = pane || tab;
    if (!target.recParts) target.recParts = [];
    target.recLen = (target.recLen || 0) + text.length;
    target.recParts.push(text);
    while (target.recLen > BUF_MAX && target.recParts.length) {
      target.recLen -= target.recParts.shift().length;
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
      let tab = tabs.find(t => t.id === m.id);
      let pane = null;
      if (!tab) for (const t of tabs) {
        const p = (t.extraPanes || []).find(x => x.connId === m.id);
        if (p) { tab = t; pane = p; break; }
      }
      if (tab) {
        if (pane) {
          pane.state = m.state;
          if (m.state === 'connected') { fitTerm(pane); }
        } else {
          setTabState(m.id, m.state, m.msg);
        }
        if (m.state === 'connected') {
          tab.cfg._serverCfg = m.cfg;
          if (!pane) {
            fitTerm(tab);
            // 连接后自动执行 (Xshell 登录脚本风格): IP 命令集 auto + 会话 autoCmds
            setTimeout(() => runAutoCmds(tab.cfg), 300);
          }
        }
      }
      break;
    }
    case 'error': {
      sftpBusy = false;                 // SFTP 加载失败也释放锁
      // 串口被占用 → 弹窗 (等待重试/强制释放/取消)
      if (m.occupied) { showOccDlg(m); break; }
      let tab = tabs.find(t => t.id === m.id);
      let pane = null;
      if (!tab) for (const t of tabs) {
        const p = (t.extraPanes || []).find(x => x.connId === m.id);
        if (p) { tab = t; pane = p; break; }
      }
      const term = pane ? pane.term : (tab ? tab.term : null);
      if (term) { term.writeln(`\r\n\x1b[31m[错误] ${m.msg}\x1b[0m`); if (!pane) setTabState(tab.id, 'closed', '出错'); }
      else setStatus(`错误: ${m.msg}`);
      break;
    }
    case 'serial-free': {
      // 强制释放结果: 成功则自动重连
      stopOccRetry();
      if (m.ok) {
        setStatus(m.msg);
        const tab = _occTab;
        _occTab = null;
        if (tab && tabs.includes(tab)) {
          setTimeout(() => send({ type: 'connect', session: tab.cfg, id: tab.id }), 800);
        }
      } else {
        setStatus(m.msg);
        if (_occTab) showOccDlg({ id: _occTab.id, msg: m.msg });
      }
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
    case 'scan': {
      renderScan(m);
      break;
    }
    case 'scan-net': {
      renderScanNet(m);
      break;
    }
    case 'zmodem': {
      // Zmodem 文件接收完成: 终端提示 + 状态栏
      const tab = tabs.find(t => t.id === m.id);
      const fileName = m.filename || 'file';
      if (tab) {
        tab.term.writeln(`\r\n\x1b[32m[Zmodem] 已接收: ${fileName} (${fmtSize(m.size)})\x1b[0m`);
        tab.term.writeln(`\x1b[33m点击下载: /api/zmodem/download?file=${encodeURIComponent(fileName)}\x1b[0m`);
      }
      setStatus(`Zmodem 收到文件: ${fileName} (${fmtSize(m.size)})`);
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

// ---------- 国际化 (中/英) ----------
const I18N = {
  zh: {
    btn_new: '＋ 新建连接', btn_save: '💾 保存会话', btn_log: '📋 日志',
    btn_sftp: '📁 文件', btn_killall: '⏹ 全部关闭', btn_lang: '🌐 EN',
    dl_title_new: '新建连接', dl_title_edit: '编辑会话',
    dl_conn: '连接', dl_save_conn: '保存并连接', dl_cancel: '取消',
    f_name: '会话名称', f_type: '类型', f_host: '主机', f_port: '端口',
    f_user: '用户名', f_auth: '认证方式', f_password: '密码', f_key: '私钥路径',
    f_passphrase: '密钥口令', f_proxy: '代理', f_proxy_addr: '代理地址',
    t_autologin: '自动登录', s_baud: '波特率', s_hex: 'HEX 显示/发送',
    sftp_up: '上级', sftp_upload: '上传', sftp_upload_dir: '传文件夹',
    sftp_refresh: '刷新', sftp_close: '关闭', sftp_dl: '下载', sftp_dir_dl: '打包下载',
    side_title: '已保存会话', side_batch: '批量', side_foot: '双击连接',
    batch_all: '全选', batch_del: '删除选中', batch_cancel: '取消',
    close_title: '关闭会话?', close_ok: '确认关闭', welcome_p: 'SSH · Telnet · 串口 一体化连接工具',
    ws_ok: '服务器已连接', ws_off: '服务器已断开', ws_init: '未连接服务器',
  },
  en: {
    btn_new: '＋ New', btn_save: '💾 Save', btn_log: '📋 Log',
    btn_sftp: '📁 Files', btn_killall: '⏹ Close All', btn_lang: '🌐 中文',
    dl_title_new: 'New Connection', dl_title_edit: 'Edit Session',
    dl_conn: 'Connect', dl_save_conn: 'Save & Connect', dl_cancel: 'Cancel',
    f_name: 'Name', f_type: 'Type', f_host: 'Host', f_port: 'Port',
    f_user: 'Username', f_auth: 'Auth', f_password: 'Password', f_key: 'Private Key',
    f_passphrase: 'Passphrase', f_proxy: 'Proxy', f_proxy_addr: 'Proxy Address',
    t_autologin: 'Auto login', s_baud: 'Baud', s_hex: 'HEX mode',
    sftp_up: 'Up', sftp_upload: 'Upload', sftp_upload_dir: 'Folder',
    sftp_refresh: 'Refresh', sftp_close: 'Close', sftp_dl: 'Download', sftp_dir_dl: 'Zip',
    side_title: 'Sessions', side_batch: 'Batch', side_foot: 'Double-click to connect',
    batch_all: 'All', batch_del: 'Delete', batch_cancel: 'Cancel',
    close_title: 'Close session?', close_ok: 'Close', welcome_p: 'SSH · Telnet · Serial all-in-one',
    ws_ok: 'Server connected', ws_off: 'Server disconnected', ws_init: 'Not connected',
  },
};
let LANG = localStorage.getItem('sshterm.lang') || 'zh';
function t(key) { return (I18N[LANG] && I18N[LANG][key]) || I18N.zh[key] || key; }
function applyI18n() {
  const map = {
    'btn-new': 'btn_new', 'btn-save': 'btn_save',
    'btn-sftp': 'btn_sftp', 'btn-killall': 'btn_killall',
    'btn-batch': 'side_batch',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  }
  const dyn = {
    'btn-dlg-conn': 'dl_conn', 'btn-dlg-save': 'dl_save_conn', 'btn-dlg-cancel': 'dl_cancel',
    'btn-close-ok': 'close_ok', 'btn-close-cancel': 'dl_cancel',
    'sftp-up': 'sftp_up', 'sftp-upload': 'sftp_upload', 'sftp-upload-dir': 'sftp_upload_dir',
    'sftp-refresh': 'sftp_refresh', 'sftp-close': 'sftp_close',
    'batch-del-text': 'batch_del', 'batch-cancel': 'batch_cancel',
  };
  for (const [id, key] of Object.entries(dyn)) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  }
  $('batch-all').parentElement.firstChild.textContent = t('batch_all') + ' ';
  $('dlg-title').textContent = t('dl_title_new');
  document.querySelectorAll('label[for]').forEach(() => {});
  // 状态栏
  if (ws && ws.readyState === 1) $('conn-status-text').textContent = t('ws_ok');
}
function toggleLang() {
  LANG = LANG === 'zh' ? 'en' : 'zh';
  localStorage.setItem('sshterm.lang', LANG);
  applyI18n();
  setStatus(t(LANG === 'zh' ? 'ws_ok' : 'ws_ok'));
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
    allowProposedApi: true,   // SearchAddon decorations (搜索高亮) 需要
    theme: { background: '#1a1b26', foreground: '#c0caf5' },
  });
  const fitAddon = new (FitAddonCtor)();
  term.loadAddon(fitAddon);
  let searchAddon = null;
  if (SearchAddonCtor) {
    searchAddon = new SearchAddonCtor();
    term.loadAddon(searchAddon);
    // 搜索结果计数
    searchAddon.onDidChangeResults((r) => {
      if ($('search-count') && !$('search-bar').classList.contains('hidden')) {
        $('search-count').textContent = r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : '0';
      }
    });
  }
  term.open(host);
  setTimeout(() => fitAddon.fit(), 0);

  const tab = { id, cfg, term, host, state: 'idle', hex: !!(opts.hex ?? cfg.hexMode), fitAddon, searchAddon, recParts: [], recLen: 0, extraPanes: [] };
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
    if (mod && k === 'f') { openSearch(); return false; }
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
  const tab = tabs[idx];
  for (const p of tab.extraPanes) {
    send({ type: 'disconnect', id: p.connId });
    try { p.term.dispose(); } catch (e) {}
    p.host.remove();
  }
  send({ type: 'disconnect', id });
  tabs.splice(idx, 1);
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
  $('f-proxy-type').value = existing?.proxy?.type || '';
  $('f-proxy-host').value = existing?.proxy?.host || '';
  $('f-proxy-port').value = existing?.proxy?.port || '';
  $('t-host').value = existing?.host || '';
  $('t-port').value = existing?.port || 23;
  $('t-autologin').checked = !!existing?.autoLogin;
  $('t-user').value = existing?.loginUser || '';
  $('t-pass').value = '';
  $('f-autocmds').value = (existing?.autoCmds || []).join('\n');
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
  const proxy = $('f-proxy-type').value;
  $('f-proxy-wrap').classList.toggle('hidden', !proxy);
  const auto = $('t-autologin').checked;
  $('t-user-wrap').classList.toggle('hidden', !auto);
  $('t-pass-wrap2').classList.toggle('hidden', !auto);
}

function collectDlg() {
  const type = $('f-type').value;
  const base = { id: editingId || undefined, name: $('f-name').value.trim(), type };
  if (type === 'ssh') {
    const ptype = $('f-proxy-type').value;
    Object.assign(base, {
      host: $('f-host').value.trim(), port: parseInt($('f-port').value, 10) || 22,
      username: $('f-user').value.trim(), auth: $('f-auth').value,
      password: $('f-password').value || undefined,
      privateKey: $('f-key').value.trim() || undefined,
      passphrase: $('f-passphrase').value || undefined,
      proxy: ptype ? {
        type: ptype,
        host: $('f-proxy-host').value.trim(),
        port: parseInt($('f-proxy-port').value, 10) || 1080,
      } : undefined,
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
  // 连接后自动执行脚本 (所有协议通用)
  const autoCmds = $('f-autocmds').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (autoCmds.length) base.autoCmds = autoCmds;
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

// ---------- 终端搜索 (Ctrl+F, SearchAddon 高亮) ----------
let _searchActive = false;
function openSearch() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  _searchActive = true;
  $('search-bar').classList.remove('hidden');
  $('search-input').focus();
  $('search-input').select();
  doSearch();
}
function closeSearch() {
  _searchActive = false;
  $('search-bar').classList.add('hidden');
  $('search-input').value = '';
  $('search-count').textContent = '';
}
function doSearch(dir = 1) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.searchAddon) return;
  const q = $('search-input').value;
  if (!q) { $('search-count').textContent = ''; return; }
  try {
    if (dir > 0) tab.searchAddon.findNext(q, { decorations: { matchBackground: '#2d3a5f' } });
    else tab.searchAddon.findPrevious(q, { decorations: { matchBackground: '#2d3a5f' } });
  } catch (e) { /* 忽略 */ }
}
// 事件
$('search-input').addEventListener('input', () => doSearch(1));
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') closeSearch();
});
$('search-next').onclick = () => doSearch(1);
$('search-prev').onclick = () => doSearch(-1);
$('search-close').onclick = closeSearch;

// ---------- 定时发送 (串口/SSH/Telnet 通用, 入口在下拉菜单 ☰) ----------
let _timerHandle = null;
$('btn-tm-cancel').onclick = () => $('dlg-timer-mask').classList.add('hidden');
$('btn-tm-start').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  const content = $('tm-content').value;
  const interval = parseInt($('tm-interval').value, 10) || 1000;
  if (!content) return setStatus('请输入发送内容');
  stopTimer();
  _timerHandle = setInterval(() => {
    const t = tabs.find(x => x.id === activeTabId);
    if (!t || t.state !== 'connected') return;
    if ($('tm-hex').checked) {
      // HEX 发送: "AB CD EF" → bytes
      const bytes = content.split(/[\s,]+/).filter(Boolean).map(h => parseInt(h, 16));
      if (bytes.every(b => !isNaN(b))) sendInput(t.id, String.fromCharCode(...bytes));
    } else {
      sendInput(t.id, content);
    }
  }, interval);
  $('dlg-timer-mask').classList.add('hidden');
  setStatus(`定时发送已开始: ${interval}ms`);
  log(`定时发送开始: ${interval}ms "${content}"`);
};
$('btn-tm-stop').onclick = () => { stopTimer(); $('dlg-timer-mask').classList.add('hidden'); setStatus('定时发送已停止'); };
function stopTimer() { if (_timerHandle) { clearInterval(_timerHandle); _timerHandle = null; } }

// ---------- 快捷命令 (Xshell 命令集: 按 IP 独立, 可连接时自动执行) ----------
// 存储: localStorage['sshterm.commands.<ip>'] = { auto: bool, items: [{name, cmd}] }
function sessionCmdKey(cfg) {
  // 命令集按 IP (host) 隔离: 同一 IP 的所有会话共享
  return (cfg && cfg.host) || 'default';
}
let cmdKey = 'default';
let cmdSet = { auto: false, items: [] };
function loadCommands() {
  try {
    const raw = localStorage.getItem('sshterm.commands.' + cmdKey);
    const d = JSON.parse(raw || '[]');
    if (Array.isArray(d)) cmdSet = { auto: false, items: d };   // 兼容旧格式
    else cmdSet = { auto: !!d.auto, items: Array.isArray(d.items) ? d.items : [] };
  } catch (e) { cmdSet = { auto: false, items: [] }; }
}
function saveCommands() {
  try { localStorage.setItem('sshterm.commands.' + cmdKey, JSON.stringify(cmdSet)); } catch (e) {}
}
function renderCommands() {
  const el = $('cmd-list');
  el.innerHTML = '';
  const tab = tabs.find(t => t.id === activeTabId);
  const curIp = cmdKey === 'default' ? '未连接' : cmdKey;
  $('cmd-cur').textContent = `命令集 (IP: ${curIp}) — ${cmdSet.items.length} 条命令`;
  $('cmd-auto').checked = cmdSet.auto;
  if (!cmdSet.items.length) {
    el.innerHTML = '<div class="muted" style="padding:10px">(该 IP 还没有命令, 上面添加)</div>';
    return;
  }
  for (let i = 0; i < cmdSet.items.length; i++) {
    const c = cmdSet.items[i];
    const row = document.createElement('div');
    row.className = 'cmd-item';
    row.innerHTML = `
      <span class="cmd-ico">⚡</span>
      <span class="cmd-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="cmd-cmd" title="${esc(c.cmd)}">${esc(c.cmd)}</span>
      <button class="cmd-del mini" title="删除">🗑</button>`;
    row.onclick = () => runCommand(c.cmd);
    row.querySelector('.cmd-del').onclick = (e) => {
      e.stopPropagation();
      cmdSet.items.splice(i, 1);
      saveCommands();
      renderCommands();
    };
    el.appendChild(row);
  }
}
// 执行命令: 发送到激活会话
function runCommand(cmd) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.state !== 'connected') return setStatus('会话未连接');
  sendInput(tab.id, cmd + '\n');
  setStatus(`已发送: ${cmd}`);
}
// 连接后自动执行: Xshell 风格 = 该 IP 命令集(auto=true) + 会话 autoCmds 合并执行
function runAutoCmds(cfg) {
  const tab = tabs.find(t => t.id === activeTabId && t.cfg === cfg);
  const id = tab ? tab.id : null;
  if (!id) return;
  // 1. IP 命令集 (auto 开启)
  const ipCmds = [];
  try {
    const d = JSON.parse(localStorage.getItem('sshterm.commands.' + (cfg.host || '')) || '[]');
    const set = Array.isArray(d) ? { auto: false, items: d } : d;
    if (set.auto && Array.isArray(set.items)) ipCmds.push(...set.items.map(i => i.cmd));
  } catch (e) {}
  // 2. 会话配置 autoCmds
  const cfgCmds = (cfg.autoCmds || []);
  const all = [...ipCmds, ...cfgCmds];
  if (!all.length) return;
  setStatus(`自动执行 ${all.length} 条命令...`);
  all.forEach((cmd, i) => {
    setTimeout(() => {
      const t = tabs.find(x => x.id === id);
      if (t && t.state === 'connected') sendInput(id, cmd + '\n');
    }, 800 * (i + 1));
  });
}

$('btn-cmds').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  cmdKey = sessionCmdKey(tab ? tab.cfg : null);
  loadCommands();
  $('dlg-cmds-mask').classList.remove('hidden');
  renderCommands();
};
$('cmds-close').onclick = () => $('dlg-cmds-mask').classList.add('hidden');
$('cmd-auto').onchange = () => { cmdSet.auto = $('cmd-auto').checked; saveCommands(); };
$('btn-cmd-add').onclick = () => {
  const name = $('cmd-name').value.trim();
  const cmd = $('cmd-content').value.trim();
  if (!name || !cmd) return setStatus('命令名称和内容不能为空');
  cmdSet.items.push({ name, cmd });
  saveCommands();
  $('cmd-name').value = '';
  $('cmd-content').value = '';
  renderCommands();
  setStatus(`命令已保存: ${name}`);
};
$('btn-cmd-runall').onclick = () => {
  if (!cmdSet.items.length) return setStatus('该 IP 没有命令可执行');
  cmdSet.items.forEach((c, i) => setTimeout(() => runCommand(c.cmd), 600 * i));
  setStatus(`执行 ${cmdSet.items.length} 条命令...`);
};

// ---------- 串口占用处理 (等待重试/强制释放) ----------
let _occTab = null;        // 占用弹窗关联的标签
let _occRetryTimer = null;
function showOccDlg(m) {
  const tab = tabs.find(t => t.id === m.id);
  if (!tab) return;
  _occTab = tab;
  $('occ-msg').textContent = m.msg || `串口被占用`;
  $('dlg-occ-mask').classList.remove('hidden');
}
function startOccRetry() {
  if (_occRetryTimer) return;
  setStatus('等待端口释放, 每 1.5 秒自动重试…');
  $('dlg-occ-mask').classList.add('hidden');
  _occRetryTimer = setInterval(() => {
    if (!_occTab || !tabs.includes(_occTab)) { stopOccRetry(); return; }
    send({ type: 'connect', session: _occTab.cfg, id: _occTab.id });
  }, 1500);
}
function stopOccRetry() {
  if (_occRetryTimer) { clearInterval(_occRetryTimer); _occRetryTimer = null; }
}
$('btn-occ-wait').onclick = startOccRetry;
$('btn-occ-force').onclick = () => {
  if (!_occTab) return;
  $('dlg-occ-mask').classList.add('hidden');
  setStatus('强制释放中… 请在 UAC 弹窗确认');
  send({ type: 'serial-force-free', path: _occTab.cfg.port || _occTab.cfg.port2 });
};
$('btn-occ-cancel').onclick = () => { stopOccRetry(); $('dlg-occ-mask').classList.add('hidden'); _occTab = null; };

// ---------- 端口扫描 (设备发现, 只需输入 IP, 入口在下拉菜单 ☰) ----------
const SCAN_PORTS = [21, 22, 23, 80, 443, 2000, 3389, 5555, 5900, 6379, 8080, 3306, 5432, 27017, 11211];
const PORT_NAMES = { 22: 'SSH', 23: 'Telnet', 21: 'FTP', 80: 'HTTP', 443: 'HTTPS',
  8080: 'HTTP-Proxy', 3389: 'RDP', 5900: 'VNC', 6379: 'Redis', 3306: 'MySQL',
  5432: 'PostgreSQL', 27017: 'MongoDB', 5555: 'ADB', 11211: 'Memcache', 2000: 'telnetd' };
$('btn-scan-close').onclick = () => $('dlg-scan-mask').classList.add('hidden');
$('btn-scan-start').onclick = () => {
  const target = $('scan-host').value.trim();
  if (!target) return setStatus('请输入目标 IP 或网段');
  $('scan-result').innerHTML = '<div class="muted">扫描中…</div>';
  // 含 / 或 - 视为网段 → 网络扫描 (设备发现); 单 IP → 全端口扫描
  if (target.includes('/') || target.includes('-')) {
    setStatus(`网络扫描: ${target}`);
    send({ type: 'scan-net', target });
  } else {
    send({ type: 'scan', host: target, ports: SCAN_PORTS });
  }
};
function renderScanNet(m) {
  const el = $('scan-result');
  if (!m.hosts.length) {
    el.innerHTML = `<div class="muted">未发现存活设备 (目标: ${esc(m.target)})</div>`;
    return;
  }
  const rows = m.hosts.map(h => {
    const ports = h.open.map(p => `<span class="scan-open" data-ip="${h.ip}" data-port="${p}">● ${p}${PORT_NAMES[p] ? ' (' + PORT_NAMES[p] + ')' : ''}</span>`).join(' ');
    return `<div class="scan-host"><span class="scan-ip">${h.ip}</span> ${ports}</div>`;
  }).join('');
  el.innerHTML = `<div class="muted">发现 ${m.hosts.length} 台设备 (目标: ${esc(m.target)}):</div>${rows}`;
  // 点击开放端口 → 自动填连接对话框
  el.querySelectorAll('.scan-open').forEach(span => {
    span.onclick = () => {
      const ip = span.dataset.ip, port = parseInt(span.dataset.port, 10);
      const type = port === 22 ? 'ssh' : port === 23 ? 'telnet' : 'ssh';
      openDlg({ type, name: `${ip}:${port}`, host: ip, port: port === 22 ? 22 : port });
      setStatus(`已填充连接: ${ip}:${port}`);
    };
  });
}
function renderScan(m) {
  if (!m.open.length) {
    $('scan-result').innerHTML = `<div class="muted">${esc(m.host)}: 未发现开放端口</div>`;
    return;
  }
  $('scan-result').innerHTML = `<div class="muted">${esc(m.host)} 开放端口:</div>` +
    m.open.map(p => `<div class="scan-open">● ${p} ${PORT_NAMES[p] ? ' (' + PORT_NAMES[p] + ')' : ''}</div>`).join('');
}

// ---------- 分屏 (标签内左右第二 pane, 再点按钮=关闭) ----------
$('btn-split').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.extraPanes.length) {
    // 已分屏 → 再点 = 关闭分屏 (切换式)
    closePane(tab, tab.extraPanes[0]);
    setStatus('分屏已关闭');
    return;
  }
  const host = document.createElement('div');
  host.className = 'term-host pane1';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.textContent = '✕';
  closeBtn.title = '关闭此分屏';
  host.appendChild(closeBtn);
  $('terms').appendChild(host);

  const term = new Terminal({
    fontSize: 13, fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    theme: { background: '#1a1b26', foreground: '#c0caf5' },
  });
  const fitAddon = new (FitAddonCtor)();
  term.loadAddon(fitAddon);
  term.open(host);
  setTimeout(() => fitAddon.fit(), 0);

  const pane = { connId: tabSeq++, term, host, cfg: { ...tab.cfg },
    state: 'connecting', hex: !!tab.hex, fitAddon, recParts: [], recLen: 0, logging: false, logBuf: '' };
  tab.extraPanes.push(pane);
  bindClipboard(pane);                    // 复用复制粘贴
  term.onData((d) => sendInput(pane.connId, d));
  term.onResize(({ cols, rows }) => send({ type: 'resize', id: pane.connId, cols, rows }));
  closeBtn.onclick = () => closePane(tab, pane);
  send({ type: 'connect', session: pane.cfg, id: pane.connId });
  // 焦点还给主 pane (pane1 创建时 term.open 会抢焦点)
  setTimeout(() => { if (tabs.includes(tab)) tab.term.focus(); }, 100);
  setStatus('已分屏');
};

function closePane(tab, pane) {
  send({ type: 'disconnect', id: pane.connId });
  try { pane.term.dispose(); } catch (e) {}
  pane.host.remove();
  const i = tab.extraPanes.indexOf(pane);
  if (i >= 0) tab.extraPanes.splice(i, 1);
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
// ---------- 更多工具下拉 (日志/语言/定时/扫描) ----------
$('btn-more').onclick = (e) => {
  e.stopPropagation();
  $('menu-more').classList.toggle('hidden');
};
document.addEventListener('click', () => $('menu-more').classList.add('hidden'));
$('mi-log').onclick = () => { $('menu-more').classList.add('hidden'); openLogPanel(); };
$('mi-lang').onclick = () => { $('menu-more').classList.add('hidden'); toggleLang(); };
$('mi-timer').onclick = () => {
  $('menu-more').classList.add('hidden');
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  $('dlg-timer-mask').classList.remove('hidden');
};
$('mi-scan').onclick = () => { $('menu-more').classList.add('hidden'); $('dlg-scan-mask').classList.remove('hidden'); };
$('log-close').onclick = () => $('dlg-log-mask').classList.add('hidden');
$('btn-sftp').onclick = toggleSftpPanel;
$('btn-killall').onclick = () => {
  if (!tabs.length) return setStatus('没有打开的会话');
  if (!confirm(`关闭全部 ${tabs.length} 个会话? (将断开所有连接)`)) return;
  const n = tabs.length;
  for (const t of [...tabs]) doCloseTab(t.id);
  setStatus(`已关闭 ${n} 个会话`);
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

// SFTP 上传: 断点续传 + 大文件分块并行
// 查询远端文件已存在大小 (HEAD)
function remoteSize(url) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('HEAD', url);
    xhr.onload = () => {
      const sz = xhr.getResponseHeader('X-Remote-Size');
      resolve(sz ? parseInt(sz, 10) : 0);
    };
    xhr.onerror = () => resolve(0);
    xhr.send();
  });
}
// 上传单个文件: 断点续传 (HEAD 检查远端已有大小 → 从 offset 续传)
// 大文件(>8MB)分块并行 (PARALLEL 块)
const UPLOAD_PARALLEL = 4;
const UPLOAD_CHUNK = 8 * 1024 * 1024;
async function uploadFileSmart(tabId, dirPath, name, file, onProg) {
  const base = `/api/sftp/upload?conn=${tabId}&path=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(name)}`;
  const remote = await remoteSize(base);
  let offset = remote;
  if (offset >= file.size) { onProg(1); return 200; }   // 已完整存在

  const work = [];
  if (file.size - offset > UPLOAD_CHUNK * 2) {
    // 多线程: 从 offset 起分块并行
    const starts = [];
    for (let s = offset; s < file.size; s += UPLOAD_CHUNK) starts.push(s);
    let done = 0;
    const totalBytes = file.size - offset;
    const pool = starts.map((s, i) => {
      const end = Math.min(s + UPLOAD_CHUNK, file.size);
      const blob = file.slice(s, end);
      return xhrUpload(`${base}&offset=${s}`, blob, (loaded, t) => {
        onProg((offset + (done + (i === 0 ? loaded : 0))) / file.size);
      }).then((st) => { done += end - s; onProg((offset + done) / file.size); return st; });
    });
    const results = await Promise.all(pool);
    return results.every(s => s === 200) ? 200 : 500;
  }
  // 单线程续传: 从 offset 继续
  const blob = file.slice(offset);
  return xhrUpload(`${base}&offset=${offset}`, blob, (loaded, t) => {
    onProg((offset + loaded) / file.size);
  });
}
// 文件上传 (带断点续传/多线程 + 进度条)
$('sftp-upload').onclick = () => $('sftp-file-input').click();
$('sftp-file-input').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  showProgress(`上传: ${file.name} 0%`, 0);
  try {
    const status = await uploadFileSmart(sftpConnId, sftpPath, file.name, file,
      (p) => showProgress(`上传: ${file.name} ${(p * 100).toFixed(0)}%`, p * 100));
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
$('f-proxy-type').onchange = updateDlgFields;
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
applyI18n();
