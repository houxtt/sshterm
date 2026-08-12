// 构建独立 EXE: npx caxa 将 Node.js + 项目打包为单个可执行文件
// 用法: node scripts/build-exe.js
// 前置: npm install -g caxa  (如需, 先 npm install -g caxa)
const { execSync } = require('child_process');
const { existsSync, mkdirSync, writeFileSync } = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const TARGET = path.join(OUT, 'sshterm.exe');

console.log('┌─ sshterm EXE 构建 ───────────────────┐');

// 1. 检查 caxa
try { execSync('npx caxa --version', { stdio: 'pipe' }); console.log('│ caxa: ✓'); }
catch { console.log('│ caxa: 安装中…'); execSync('npm install -g caxa', { stdio: 'inherit' }); }

// 2. 确保 dist/
mkdirSync(OUT, { recursive: true });

// 3. 构建
console.log(`│ 输出: ${TARGET}`);
console.log('│ 打包中 (可能需要几分钟)…');
try {
  execSync(
    `npx caxa --directory "${ROOT}"` +
    ` --output "${TARGET}"` +
    ` --command "{{caxa}}/node_modules/.bin/node"` +
    ` -- "{{caxa}}/server/index.js" "--no-open"`,
    { stdio: 'inherit', cwd: ROOT }
  );
  console.log('│ ✅ 构建成功');
  console.log(`│ ${TARGET}`);
  console.log('│ 双击 sshterm.exe 启动 (服务在后台, 浏览器打开 http://127.0.0.1:8787)');
} catch (e) {
  console.log('│ ❌ caxa 构建失败');
  console.log('│ 备选方案: ');
  console.log('│   1. 确保已安装 Node.js');
  console.log('│   2. 双击 run.bat 即可启动 (无需 EXE)');
  console.log('│   3. 或创建桌面快捷方式指向 run.bat');
}
console.log('└──────────────────────────────────────┘');
