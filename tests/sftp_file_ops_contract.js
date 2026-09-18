// SFTP 远端文件管理契约测试: 重命名/删除/权限 (服务端路由 + 前端 UI + 翻译)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
require(path.join(root, 'scripts', 'sync-web-app')).syncWebApp();
const sftpHttp = fs.readFileSync(path.join(root, 'server', 'sftp-http.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'web', 'js', 'i18n.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
const fixture = fs.readFileSync(path.join(root, 'server', 'test-sftp-fixture.js'), 'utf8');

// ---------- 服务端路由契约 ----------
for (const action of ['rename', 'delete', 'chmod']) {
  assert(
    sftpHttp.includes(`req.method === 'POST' && url.startsWith('/api/sftp/${action}')`),
    `server route POST /api/sftp/${action} missing`,
  );
}
// 连接与窗口命名空间: 一律经 getHttpConnection(qs) 解析 (携带 token+window)
assert.strictEqual(
  (sftpHttp.match(/const conn = getHttpConnection\(qs\);/g) || []).length >= 6,
  true,
  'file-op routes must resolve connection via getHttpConnection (window namespace)',
);
// 重命名: 需要新旧路径, 禁止根目录与空字节
assert(sftpHttp.includes("sftp.rename(rpath, newPath"), 'rename must call sftp.rename');
assert(sftpHttp.includes("newPath.includes('\\0')"), 'rename must reject NUL in newPath');
// 删除: 目录必须显式递归确认, 文件走 unlink
assert(sftpHttp.includes('sftp.unlink(rpath'), 'delete must unlink non-directories');
assert(sftpHttp.includes("递归删除(recursive=1)"), 'directory delete must require recursive=1 confirmation');
assert(sftpHttp.includes("rpath === '/'"), 'delete must refuse root path');
assert(sftpHttp.includes('sftp.rmdir(dir'), 'recursive delete must rmdir emptied directories');
// 权限: 八进制校验, 仅文件有效
assert(sftpHttp.includes("sftp.chmod(rpath, mode"), 'chmod must call sftp.chmod');
assert(sftpHttp.includes('/^[0-7]{3,4}$/.test(modeText)'), 'chmod must validate octal mode');
assert(sftpHttp.includes('权限修改仅支持文件'), 'chmod must reject directories');

// ---------- 前端 UI 契约 ----------
assert(app.includes("apiUrl(`/api/sftp/${action}`"), 'frontend must call apiUrl so token+window are attached');
assert(app.includes("method: 'POST'"), 'file-op fetch must use POST');
assert(app.includes('function sftpRenameItem'), 'rename handler missing');
assert(app.includes('function sftpDeleteItem'), 'delete handler missing');
assert(app.includes('function sftpChmodItem'), 'chmod handler missing');
assert(app.includes('window.confirm(`${tip}\\n${entry.name}`)'), 'delete must confirm before request');
assert(app.includes("recursive: entry.isDir ? '1' : '0'"), 'directory delete must pass recursive=1 after confirm');
assert(app.includes("addEventListener('contextmenu'"), 'rows must wire the context menu');
assert(app.includes("class=\"mini sftp-rename\""), 'row rename button missing');
assert(app.includes("class=\"mini danger sftp-del\""), 'row delete button missing');
assert(app.includes("t('sftp_rename_prompt')"), 'rename prompt must use i18n');
assert(app.includes('closeSftpCtxMenu()'), 'context menu must be dismissed');

// ---------- 翻译契约 ----------
const zhKeys = [
  'sftp_op_rename', 'sftp_op_delete', 'sftp_op_chmod',
  'sftp_rename_prompt', 'sftp_delete_dir_confirm',
  'sftp_chmod_prompt', 'sftp_chmod_file_only', 'sftp_op_failed',
];
for (const key of zhKeys) {
  assert(i18n.includes(`${key}: `), `i18n key ${key} missing`);
}
// 中/英两份翻译都需要: 检查 en 段落也含同名 key
const enSection = i18n.slice(i18n.indexOf('en: {'));
for (const key of ['sftp_op_rename', 'sftp_delete_confirm', 'sftp_chmod_done']) {
  assert(enSection.includes(`${key}: `), `i18n en key ${key} missing`);
}

// ---------- 样式契约 ----------
assert(css.includes('.sftp-ctx-menu'), 'context menu style missing');
assert(css.includes('.sftp-ctx-item.danger'), 'danger menu item style missing');

// ---------- 测试夹具契约 (集成测试可用) ----------
for (const method of ['rename(', 'unlink(', 'rmdir(', 'chmod(', 'lstat(', 'readdir(']) {
  assert(fixture.includes(method), `fixture sftp.${method} missing`);
}

console.log('✅ sftp file ops (rename/delete/chmod) contract passed');
