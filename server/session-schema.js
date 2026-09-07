'use strict';

// Shared session config schema for save/load and API sanitization.
const ALLOWED = [
  'id', 'name', 'type', 'host', 'port', 'port2', 'username', 'user', 'auth',
  'password', 'privateKey', 'passphrase', 'loginPass', 'rememberPassword',
  'autoLogin', 'loginUser', 'reconnect', 'sortOrder', 'proxyJump', 'readyTimeout',
  'encoding', 'baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl',
  'tunnels', 'proxy', 'jumpAuth', 'agentForward',
  'group', 'autoCmds', 'rtscts', 'hexMode', 'timestamp', 'trigger', 'viewOnly',
  'connect', 'readonly', 'replay',
];

function sanitizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  const out = JSON.parse(JSON.stringify(s));
  for (const key of Object.keys(out)) {
    if (!ALLOWED.includes(key)) delete out[key];
  }
  if (!['ssh', 'telnet', 'vnc', 'serial'].includes(out.type)) return null;
  out.name = String(out.name || '').trim().slice(0, 120);
  if (!out.name) return null;

  if (out.type === 'serial') {
    out.port = String(out.port || '').trim().slice(0, 64);
    if (!out.port) return null;
    if (out.port2 !== undefined) out.port2 = String(out.port2 || '').trim().slice(0, 64);
  } else if (out.port !== undefined) {
    const p = Number(out.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      out.port = out.type === 'vnc' ? 5901 : 22;
    }
  }

  if (out.host !== undefined) out.host = String(out.host || '').trim().slice(0, 253);

  if (out.group !== undefined) out.group = String(out.group || '').trim().slice(0, 64);
  if (Array.isArray(out.autoCmds)) {
    out.autoCmds = out.autoCmds.slice(0, 64).map(v => String(v || '').slice(0, 4096));
  } else delete out.autoCmds;
  if (out.trigger !== undefined) out.trigger = String(out.trigger || '').slice(0, 256);
  if (typeof out.rtscts === 'boolean') out.rtscts = !!out.rtscts;
  if (typeof out.hexMode === 'boolean') out.hexMode = !!out.hexMode;
  if (typeof out.timestamp === 'boolean') out.timestamp = !!out.timestamp;
  if (typeof out.viewOnly === 'boolean') out.viewOnly = !!out.viewOnly;
  if (typeof out.readonly === 'boolean') out.readonly = !!out.readonly;
  if (typeof out.connect === 'boolean') out.connect = !!out.connect;

  if (out.proxy && typeof out.proxy === 'object') {
    const proxy = {
      type: ['socks5', 'http'].includes(String(out.proxy.type || '').toLowerCase())
        ? String(out.proxy.type).toLowerCase() : 'http',
      host: String(out.proxy.host || '').trim().slice(0, 253),
      port: Number(out.proxy.port),
    };
    if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
      delete out.proxy;
    } else {
      if (typeof out.proxy.username === 'string') proxy.username = out.proxy.username.slice(0, 256);
      if (typeof out.proxy.password === 'string') proxy.password = out.proxy.password.slice(0, 256);
      out.proxy = proxy;
    }
  }

  if (out.jumpAuth && typeof out.jumpAuth === 'object') {
    const ja = {};
    if (typeof out.jumpAuth.auth === 'string') ja.auth = out.jumpAuth.auth.slice(0, 64);
    if (typeof out.jumpAuth.username === 'string') ja.username = out.jumpAuth.username.slice(0, 256);
    if (typeof out.jumpAuth.password === 'string') ja.password = out.jumpAuth.password.slice(0, 256);
    if (typeof out.jumpAuth.privateKey === 'string') ja.privateKey = out.jumpAuth.privateKey;
    if (typeof out.jumpAuth.passphrase === 'string') ja.passphrase = out.jumpAuth.passphrase.slice(0, 256);
    out.jumpAuth = ja;
  }

  return out;
}

module.exports = { sanitizeSession, ALLOWED };
