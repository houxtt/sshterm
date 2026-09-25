// 构建独立 EXE: caxa 将 Node.js + 项目打包为单个可执行文件
// 用法: node scripts/build-exe.js
// 前置: 已装全局 caxa (npm install -g caxa) 或本机有 npx caxa
//
// 产物: dist/sshterm.exe
//   - 双击即启动后台服务并自动打开浏览器 http://127.0.0.1:8787
//   - 无需对方安装 Node.js
//   - 已用 staging 只打包运行时 (server / web / node_modules)，体积约 50MB
const { execSync } = require('child_process');
const { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, rmSync, writeFileSync } = require('fs');
const os = require('os');
const path = require('path');
const { gzipSync } = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const TARGET = path.join(OUT, 'sshterm.exe');

console.log('┌─ sshterm EXE 构建 ───────────────────┐');

// 1. 检查 caxa (优先使用项目 devDependency)
try {
  execSync('npx caxa --version', { stdio: 'pipe', cwd: ROOT });
  console.log('│ caxa: ✓');
} catch {
  console.log('│ caxa: 安装中…');
  execSync('npm install --no-save caxa@3.0.0', { stdio: 'inherit', cwd: ROOT });
}

// 2. 确保 dist/
mkdirSync(OUT, { recursive: true });

// 3. 构建采用 staging 目录: 只复制运行时文件再打包, 不依赖 caxa 的
//    --exclude 语义 (实测对目录不生效, 曾把产物撑到 1GB)。
const STAGING = path.join(os.tmpdir(), `sshterm-caxa-${process.pid}`);
const COPY_DIRS = ['server', 'web', 'node_modules'];
const COPY_FILES = ['package.json', 'package-lock.json', 'LICENSE'];
const RUNTIME_PAYLOAD = path.join('runtime', 'node-runtime.gz');

function prepareStaging() {
  mkdirSync(STAGING, { recursive: true });
  for (const dir of COPY_DIRS) {
    cpSync(path.join(ROOT, dir), path.join(STAGING, dir), { recursive: true });
  }
  for (const file of COPY_FILES) {
    copyFileSync(path.join(ROOT, file), path.join(STAGING, file));
  }

  // Remove build-only packages without contacting the registry. caxa's own
  // dedupe step can otherwise wait indefinitely on a restricted network.
  execSync('npm prune --omit=dev --ignore-scripts --offline', {
    stdio: 'pipe',
    cwd: STAGING,
  });

  // Store Node as a compressed payload rather than caxa's cached node.exe.
  // Cleanup/security tools may remove executables from %TEMP% while leaving
  // caxa's application directory behind. The packaged launcher can restore
  // this runtime payload whenever that happens.
  const runtimePayload = path.join(STAGING, RUNTIME_PAYLOAD);
  mkdirSync(path.dirname(runtimePayload), { recursive: true });
  writeFileSync(runtimePayload, gzipSync(readFileSync(process.execPath), { level: 9 }));
  console.log(`│ staging: ${STAGING}`);
}

// 5. 验证运行时资源 (串口释放脚本必须包含在产物中)
function assertRuntimeResources() {
  const required = [
    path.join(ROOT, 'server', 'free-serial.ps1'),
    path.join(ROOT, 'server', 'index.js'),
    path.join(ROOT, 'server', 'packaged-launcher.ps1'),
    path.join(STAGING, RUNTIME_PAYLOAD),
    path.join(STAGING, 'node_modules', 'serialport', 'package.json'),
  ];
  for (const file of required) {
    if (!existsSync(file)) throw new Error(`缺少运行时资源: ${file}`);
  }
}

// 4. 构建 (不传 --no-open, 双击自动开浏览器; 对方如需静默可加 --no-open)
console.log(`│ 输出: ${TARGET}`);
console.log('│ 打包中 (可能需要几分钟)…');
try {
  prepareStaging();
  assertRuntimeResources();
  execSync(
    `npx caxa --input "${STAGING}"` +
    ` --output "${TARGET}"` +
    ` --no-dedupe` +
    ` --no-include-node` +
    ` -- "powershell.exe" "-NoLogo" "-NoProfile" "-NonInteractive"` +
    ` "-ExecutionPolicy" "Bypass" "-File" "{{caxa}}/server/packaged-launcher.ps1"`,
    { stdio: 'inherit', cwd: ROOT }
  );
  console.log('│ ✅ 构建成功');
  console.log(`│ ${TARGET}`);
  console.log('│ 双击 sshterm.exe 启动 (后台服务 + 自动打开浏览器 http://127.0.0.1:8787)');
} catch (e) {
  console.log('│ ❌ caxa 构建失败');
  const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
  if (detail) console.log(detail.split('\n').map(l => `│ ${l}`).join('\n'));
  console.log('│ 备选方案: ');
  console.log('│   1. 确保已安装 Node.js 和 npx caxa');
  console.log('│   2. 双击 run.bat 即可启动 (无需 EXE)');
  process.exitCode = 1;
} finally {
  try { rmSync(STAGING, { recursive: true, force: true }); } catch {}
}
console.log('└──────────────────────────────────────┘');
