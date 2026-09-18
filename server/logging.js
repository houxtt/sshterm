// Application / session log helpers (memory ring + on-disk files).
'use strict';
const fs = require('fs');
const path = require('path');

function createLogging(CONN_DIR) {
  const MAX_LOGS = 1000;
  const logs = [];
  const LOG_DIR = path.join(CONN_DIR, 'logs');
  const SESSION_LOG_DIR = path.join(CONN_DIR, 'session-logs');
function newLogFile() {
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  // Include milliseconds and a random suffix so two services started within
  // the same second never write into the same log file.
  const rand = Math.random().toString(36).slice(2, 6);
  return path.join(LOG_DIR, `sshterm-${ts}-${String(d.getMilliseconds()).padStart(3, '0')}-${rand}.log`);
}
let LOG_FILE = newLogFile();
function redactLog(value) {
  return String(value)
    .replace(/(password|passphrase|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1\n[REDACTED]\n$2')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}
function log(level, msg) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const entry = {
    t: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    level, msg: redactLog(msg),
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${entry.t}] [${level}] ${entry.msg}\n`);
  } catch (e) { /* 日志写入失败不影响功能 */ }
  return entry;
}
const MAX_LOG_FILES = 100;
const MAX_LOG_AGE_DAYS = 30;
function cleanupLogDirectory(dir, matcher) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(f => f.isFile() && matcher.test(f.name))
      .map(f => ({ name: f.name, path: path.join(dir, f.name), mtime: fs.statSync(path.join(dir, f.name)).mtime, size: fs.statSync(path.join(dir, f.name)).size }))
      .sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 3600 * 1000;
    for (let i = MAX_LOG_FILES; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path); } catch {}
    }
    for (const f of files.slice(0, MAX_LOG_FILES)) {
      if (f.mtime.getTime() < cutoff) {
        fs.unlinkSync(f.path);
        console.log(`[log-cleanup] 删除过期日志: ${f.name} (${f.mtime.toISOString().split('T')[0]})`);
      }
    }
    // Enforce a total size budget: delete oldest files until the directory
    // fits.  This prevents unbounded growth when many sessions run daily.
    const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MB per directory
    let total = files.slice(0, MAX_LOG_FILES).reduce((sum, f) => sum + f.size, 0);
    for (let i = MAX_LOG_FILES - 1; i >= 0 && total > MAX_TOTAL_BYTES; i--) {
      try {
        fs.unlinkSync(files[i].path);
        total -= files[i].size;
        console.log(`[log-cleanup] 超出总大小预算，删除日志: ${files[i].name}`);
      } catch {}
    }
  } catch (e) { /* 静默处理 */ }
}
function cleanupOldLogs() {
  cleanupLogDirectory(LOG_DIR, /^sshterm-\d{8}-\d{6}.*\.log$/);
  cleanupLogDirectory(SESSION_LOG_DIR, /\.log$/i);
}
// 启动时清理旧日志
setTimeout(cleanupOldLogs, 1000);
  return {
    logs,
    LOG_DIR,
    SESSION_LOG_DIR,
    get LOG_FILE() { return LOG_FILE; },
    set LOG_FILE(v) { LOG_FILE = v; },
    newLogFile,
    redactLog,
    log,
    cleanupLogDirectory,
    cleanupOldLogs,
  };
}

module.exports = { createLogging };
