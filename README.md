# sshterm v2 — Windows 桌面终端

SSH、Telnet、VNC、串口多标签连接工具，支持 SFTP、分屏、会话管理和底部快捷命令栏。桌面界面使用 Electron 和 xterm.js，连接逻辑在同一个应用进程内运行；应用不会打开浏览器，也不会监听本机 HTTP/WebSocket 端口。

## 安装与启动

从 [GitHub Releases](https://github.com/houxtt/sshterm/releases/latest) 下载 `sshterm-setup.exe` 安装后启动。安装只需一次，以后从桌面或开始菜单打开速度更快。需要免安装时可下载 `sshterm.exe` 便携版；便携版每次启动会先解压，因此会慢一些。两种版本都自带运行时，无需安装 Node.js。已有会话配置和通过 Windows DPAPI 记住的凭据保存在 `%USERPROFILE%\.sshterm`，升级不会清除。

源码运行需要 Node.js 22：

```powershell
npm ci
npm start
```

也可双击 `run.bat`。构建桌面 EXE：

```powershell
npm run check
node tests/desktop_contract.js
npm run build:exe
```

产物为 `dist/sshterm-setup.exe` 和 `dist/sshterm.exe`。正式发行版由 [Release build](docs/RELEASE.md) 工作流验证并发布；配置代码签名证书时会签名，未配置时会在发行说明中标明未签名。

## 使用

1. 点击“＋ 新建连接”，选择 SSH、Telnet、VNC 或 Serial，填写连接信息；“保存并连接”会写入会话列表。
2. 双击左侧会话可以重连；标签页支持多会话、分屏和工作区保存。
3. 点击“⚡ 命令”为当前主机添加常用命令。底部命令栏会随当前标签切换，点击按钮立即执行；普通命令可在终端内直接输入。
4. SSH 会话可通过“📁 文件”浏览、上传、下载远端文件；支持断点续传和目录下载。

快捷命令按主机保存在桌面应用的本地存储中。旧浏览器版的 localStorage 不会自动迁移，首次使用桌面版时需要重新添加；会话配置和 DPAPI 凭据继续沿用 `%USERPROFILE%\.sshterm`。

## 功能和边界

- SSH：密码、密钥、代理、跳板机、MFA、隧道、自动重连、终端尺寸同步。
- Telnet：基础交互与自动登录。
- Serial：端口枚举、波特率参数、HEX 模式。
- VNC：独立标签页、远端桌面操作。
- SFTP：文件和目录传输、续传、并发下载。
- 会话管理：分组、过滤、导入导出、工作区、分屏和主题设置。
- 复制粘贴：选中自动复制，右键粘贴，Ctrl+Shift+C/V，Ctrl+C 在未选中文本时发送中断信号。
- Zmodem 收发尚未作为正式功能提供。

桌面应用本身不占用本机监听端口。主动配置的 SSH 本地隧道仍会按用户指定端口监听，这是隧道功能本身的行为。SSH、VNC 等远端连接会正常使用出站网络连接。

## 项目结构

```text
desktop/  Electron 窗口、应用内资源协议和终端消息桥
server/   SSH、Telnet、VNC、Serial、SFTP 与会话/凭据逻辑
web/      xterm.js 界面与样式
tests/    自动化检查
```

发布前执行 `npm run check`、`node tests/desktop_contract.js`，再构建并实际运行 EXE。签名发行流程见 [docs/RELEASE.md](docs/RELEASE.md)。
