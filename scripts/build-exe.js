// 构建独立 EXE: caxa 将 Node.js + 项目打包为单个可执行文件
// 用法: node scripts/build-exe.js
// 前置: 已装全局 caxa (npm install -g caxa) 或本机有 npx caxa
//
// 产物: dist/sshterm.exe
//   - 双击即启动后台服务并自动打开浏览器 http://127.0.0.1:8787
//   - 无需对方安装 Node.js
//   - 已排除 .git / tests / perf-proto / 源码脚本等非运行时文件，体积约 160MB
const { execSync } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
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

// 3. 排除非运行时目录/文件, 缩小体积
const EXCLUDE = [
  '.git', 'tests', 'perf-proto', 'dist', 'assets',
  'node_modules/.cache', '*.log', 'scripts',
  '*.bat', '*.vbs', '*.ps1', 'README.md', 'package-lock.json'
];
const excludeArgs = EXCLUDE.map(e => ` --exclude "${e}"`).join('');

// 4. 构建 (不传 --no-open, 双击自动开浏览器; 对方如需静默可加 --no-open)
console.log(`│ 输出: ${TARGET}`);
console.log('│ 打包中 (可能需要几分钟)…');
try {
  execSync(
    `npx caxa --input "${ROOT}"` +
    ` --output "${TARGET}"` +
    excludeArgs +
    ` -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/server/index.js"`,
    { stdio: 'inherit', cwd: ROOT }
  );
  console.log('│ ✅ 构建成功');
  console.log(`│ ${TARGET}`);
  console.log('│ 双击 sshterm.exe 启动 (后台服务 + 自动打开浏览器 http://127.0.0.1:8787)');
} catch (e) {
  console.log('│ ❌ caxa 构建失败');
  console.log('│ 备选方案: ');
  console.log('│   1. 确保已安装 Node.js 和 npx caxa');
  console.log('│   2. 双击 run.bat 即可启动 (无需 EXE)');
  process.exitCode = 1;
}
console.log('└──────────────────────────────────────┘');
