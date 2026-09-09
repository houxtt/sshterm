// Session persistence helpers (JSON + DPAPI-backed secrets).
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { writeSecrets, readSecrets } = require('./dpapi');

function createSessionsStore({ CONN_DIR, CONN_FILE, CONN_BACKUP_FILE, log }) {
function writeSessionFile(data, backupExisting = true) {
  fs.mkdirSync(CONN_DIR, { recursive: true });
  const tempFile = `${CONN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  try {
    if (backupExisting && fs.existsSync(CONN_FILE)) fs.copyFileSync(CONN_FILE, CONN_BACKUP_FILE);
    fs.renameSync(tempFile, CONN_FILE);
    // A legacy file may contain plaintext credentials.  Its migration must
    // never preserve that unsafe source as the backup.
    if (!backupExisting) fs.copyFileSync(CONN_FILE, CONN_BACKUP_FILE);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}

function loadSessions() {
  if (!fs.existsSync(CONN_FILE) && !fs.existsSync(CONN_BACKUP_FILE)) return {};
  try {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
    } catch (primaryError) {
      if (!fs.existsSync(CONN_BACKUP_FILE)) throw primaryError;
      raw = JSON.parse(fs.readFileSync(CONN_BACKUP_FILE, 'utf8'));
      console.error(`[会话] 主文件读取失败，已从备份恢复: ${primaryError.message}`);
      log('error', `会话主文件读取失败，已从备份恢复: ${primaryError.message}`);
    }
    // Migrate older versions that persisted credentials. Credentials are
    // intentionally process-memory-only and must not survive a restart unless
    // the session opts in to DPAPI-backed "remember password".
    let migrated = false;
    const clean = Object.fromEntries(Object.entries(raw).map(([id, s]) => {
      const { password, passphrase, loginPass, privateKey, proxy, jumpAuth, ...safe } = s || {};
      const { password: proxyPassword, ...safeProxy } = proxy || {};
      const { password: jumpPassword, privateKey: jumpPrivateKey, passphrase: jumpPassphrase, ...safeJumpAuth } = jumpAuth || {};
      if ([password, passphrase, loginPass, privateKey, proxyPassword, jumpPassword, jumpPrivateKey, jumpPassphrase].some(v => v !== undefined)) migrated = true;
      if (proxy) safe.proxy = safeProxy;
      if (jumpAuth) safe.jumpAuth = safeJumpAuth;
      return [id, safe];
    }));
    if (migrated) {
      writeSessionFile(clean, false);
    }
    // Load DPAPI-backed secrets for sessions that opted into "remember password"
    const secrets = readSecrets();
    for (const [id, s] of Object.entries(clean)) {
      if (s.rememberPassword && secrets[id]) {
        const saved = secrets[id];
        clean[id] = {
          ...s,
          password: saved.password,
          passphrase: saved.passphrase,
          loginPass: saved.loginPass,
          privateKey: saved.privateKey,
          proxy: s.proxy ? { ...s.proxy, ...(saved.proxyPassword ? { password: saved.proxyPassword } : {}) } : s.proxy,
          jumpAuth: s.jumpAuth ? {
            ...s.jumpAuth,
            ...(saved.jumpPassword ? { password: saved.jumpPassword } : {}),
            ...(saved.jumpPrivateKey ? { privateKey: saved.jumpPrivateKey } : {}),
            ...(saved.jumpPassphrase ? { passphrase: saved.jumpPassphrase } : {}),
          } : s.jumpAuth,
        };
      }
    }
    return clean;
  }
  catch (error) {
    console.error(`[会话] 启动读取失败: ${error.message}`);
    log('error', `会话启动读取失败: ${error.message}`);
    return {};
  }
}
function saveSessions(data) {
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    // Write DPAPI-backed secrets only for opted-in sessions
    const secrets = {};
    for (const [id, s] of Object.entries(data)) {
      if (s.rememberPassword && (s.password || s.passphrase || s.loginPass || s.privateKey || s.proxy?.password ||
          s.jumpAuth?.password || s.jumpAuth?.privateKey || s.jumpAuth?.passphrase)) {
        secrets[id] = {
          password: s.password,
          passphrase: s.passphrase,
          loginPass: s.loginPass,
          privateKey: s.privateKey,
          proxyPassword: s.proxy?.password,
          jumpPassword: s.jumpAuth?.password,
          jumpPrivateKey: s.jumpAuth?.privateKey,
          jumpPassphrase: s.jumpAuth?.passphrase,
        };
      }
    }
    writeSecrets(secrets);
    // Never write reusable credentials to disk in plain JSON.
    const diskData = Object.fromEntries(Object.entries(data).map(([id, s]) => {
      const { password, passphrase, loginPass, privateKey, proxy, jumpAuth, ...safe } = s;
      if (proxy) {
        const { password: proxyPassword, ...safeProxy } = proxy;
        safe.proxy = safeProxy;
      }
      if (jumpAuth) {
        const { password: jumpPassword, privateKey: jumpPrivateKey, passphrase: jumpPassphrase, ...safeJumpAuth } = jumpAuth;
        safe.jumpAuth = safeJumpAuth;
      }
      return [id, safe];
    }));
    writeSessionFile(diskData);
  } catch (e) {
    console.error('[会话] 保存失败:', e.message);
    log('error', `会话或加密凭据保存失败: ${e.message}`);
    throw e;
  }
}

function storedSessionForConfig(config) {
  if (!config || !config.type) return null;
  if (config.id && sessions[config.id]) return sessions[config.id];
  if (!['ssh', 'telnet', 'vnc'].includes(config.type)) return null;
  const defaultPort = config.type === 'telnet' ? 23 : (config.type === 'vnc' ? 5901 : 22);
  const host = String(config.host || '').trim().toLowerCase();
  const port = Number(config.port || defaultPort);
  const username = String(config.username || config.user || '').trim();
  if (!host) return null;
  const matches = Object.values(sessions).filter(saved =>
    saved?.type === config.type &&
    String(saved.host || '').trim().toLowerCase() === host &&
    Number(saved.port || defaultPort) === port &&
    (config.type === 'vnc' || String(saved.username || saved.user || '').trim() === username));
  // Never guess between duplicate endpoints that may intentionally use
  // different credentials. The stable session id remains authoritative.
  return matches.length === 1 ? matches[0] : null;
}

function mergeStoredCredentials(config, stored) {
  if (!stored) return config;
  if (!config.id && stored.id) config.id = stored.id;
  // A restored browser workspace may still contain an older, sanitized Telnet
  // config after the saved session was edited.  Reconnects for the same stable
  // session id must use the durable login policy; otherwise an already-open tab
  // can keep reconnecting with autoLogin=false and be kicked by telnetd every
  // 60 seconds even though the saved session has been fixed.
  if (config.type === 'telnet' && config.id && stored.id === config.id) {
    if (typeof stored.autoLogin === 'boolean') config.autoLogin = stored.autoLogin;
    if (typeof stored.loginUser === 'string') config.loginUser = stored.loginUser;
    if (typeof stored.reconnect === 'boolean') config.reconnect = stored.reconnect;
  }
  for (const key of ['password', 'privateKey', 'passphrase', 'loginPass']) {
    if (!config[key]) config[key] = stored[key];
  }
  if (config.proxy && !config.proxy.password && stored.proxy?.password) {
    config.proxy = { ...config.proxy, password: stored.proxy.password };
  }
  if (config.jumpAuth && stored.jumpAuth) {
    for (const key of ['password', 'privateKey', 'passphrase']) {
      if (!config.jumpAuth[key] && stored.jumpAuth[key]) config.jumpAuth[key] = stored.jumpAuth[key];
    }
  }
  return config;
}

function sanitize(s) {
  // 返回给前端时剥除敏感字段 (密码/私钥/口令)
  const { password, privateKey, passphrase, loginPass, proxy, jumpAuth, ...rest } = s;
  if (proxy) {
    const { password: proxyPassword, ...safeProxy } = proxy;
    rest.proxy = safeProxy;
  }
  if (jumpAuth) {
    const { password: jumpPassword, privateKey: jumpPrivateKey, passphrase: jumpPassphrase, ...safeJumpAuth } = jumpAuth;
    rest.jumpAuth = safeJumpAuth;
  }
  return rest;
}
function sessionSortOrder(session, fallback) {
  const value = Number(session && session.sortOrder);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function sessionsList() {
  return Object.values(sessions)
    .map((session, index) => ({ session, index }))
    .sort((a, b) => sessionSortOrder(a.session, a.index) - sessionSortOrder(b.session, b.index))
    .map(({ session }) => sanitize(session));
}
function nextSessionSortOrder() {
  return Object.values(sessions).reduce(
    (max, session, index) => Math.max(max, sessionSortOrder(session, index)), -1) + 1;
}
function importSessionEntries(entries, source) {
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('导入会话数量无效（最多 500 个）');
  const names = new Set(Object.values(sessions).map(s => s.name));
  const acceptedTypes = new Set(['ssh', 'telnet', 'vnc', 'serial']);
  let count = 0;
  for (const item of entries) {
    if (!item || typeof item !== 'object' || !acceptedTypes.has(item.type)) continue;
    const session = JSON.parse(JSON.stringify(item)); // drops hostile prototypes
    let name = String(session.name || '').trim().slice(0, 120);
    if (!name) continue;
    const original = name;
    let suffix = 2;
    while (names.has(name)) name = `${original} (${suffix++})`;
    names.add(name);
    session.id = randomUUID();
    session.name = name;
    // Imported OpenSSH IdentityFile paths use the existing DPAPI-backed key
    // path field; a portable backup retains its own rememberPassword choice.
    if (source === 'openssh' && session.privateKey) session.rememberPassword = true;
    session.sortOrder = nextSessionSortOrder();
    sessions[session.id] = session;
    count++;
  }
  if (!count) throw new Error('没有可导入的有效会话');
  saveSessions(sessions);
  log('audit', `导入 ${count} 个会话（${source}）`);
  return count;
}

  let sessions = loadSessions();
  log('info', `已加载 ${Object.keys(sessions).length} 个保存会话`);

  return {
    get sessions() { return sessions; },
    set sessions(v) { sessions = v; },
    writeSessionFile,
    loadSessions,
    saveSessions,
    storedSessionForConfig,
    mergeStoredCredentials,
    sanitize,
    sessionSortOrder,
    sessionsList,
    nextSessionSortOrder,
    importSessionEntries,
  };
}

module.exports = { createSessionsStore };
