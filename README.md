# sshterm — SSH / Telnet / 串口 多标签连接工具

轻量、快速的 Windows 连接工具:点选即连,多标签同时管理 SSH / Telnet / 串口会话。
浏览器界面(xterm.js 渲染,与 VSCode 终端同款),本地 Node 服务承载连接。

## 快速开始

### 首次运行

首次运行建议双击 `run.bat`。它会检查 Node.js、在缺少 `node_modules` 时自动安装依赖，然后启动服务并打开浏览器：

```bat
run.bat
```

`run.bat` 是前台诊断启动方式，因此会保留一个命令窗口；关闭该窗口会停止服务。

### 无命令窗口启动（推荐日常使用）

完成首次依赖安装后，双击：

```text
launcher.vbs
```

启动器会：

- 从项目所在目录调用 `launch.ps1`，不依赖写死的安装路径；
- 在后台隐藏启动 Node 服务，不显示命令窗口；
- 等待服务就绪后自动打开 `http://127.0.0.1:8787/`；
- 如果服务已经运行且源码未变化，直接打开现有服务页面，不重复启动；
- 如果服务端源码在上次启动后更新，自动关闭旧进程并加载新版，避免继续使用旧的传输逻辑；
- 所有浏览器页面关闭约 10 秒后自动结束后台服务。

也可以手动执行隐藏启动脚本：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\sshterm\launch.ps1"
```

或在终端前台手动启动：

```bash
npm install      # 仅首次或依赖发生变化时需要
npm start
# 浏览器打开 http://127.0.0.1:8787
```

### 启动故障排查

隐藏启动不会弹出错误窗口。如果双击 `launcher.vbs` 后没有打开页面，请检查：

```text
%USERPROFILE%\.sshterm\logs\launcher.log
%USERPROFILE%\.sshterm\logs\server-stderr.log
%USERPROFILE%\.sshterm\logs\server-stdout.log
```

常用检查命令：

```powershell
where.exe node
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/
```

如果 `where.exe node` 找不到 Node.js，请先安装 Node.js；如果依赖尚未安装，请运行一次 `run.bat` 或 `npm install`。

## 功能

| 协议 | 支持 | 说明 |
|---|---|---|
| SSH | 密码 / 密钥认证 | 交互式 shell,支持 resize |
| SSH 文件 | **SFTP 浏览 + 上传/下载** | 支持进度、断点续传；大文件及目录 ZIP 直接流式写盘，不占用整文件内存 |
| Telnet | 基本 + 自动登录 | IAC 协商,login/Password 自动填充 |
| 串口 | 全参数 + HEX 模式 | COM 口自动枚举,波特率至 921600 |

- 多标签:每标签一个连接,随时切换/关闭
- 刷新保持连接:Ctrl+F5 后在 10 秒宽限期内重新挂接原 SSH/Telnet/串口连接，不重复登录或执行自动命令
- 分屏:当前标签可创建第二个独立连接终端,支持拖动中间分隔条调整比例
- 工作区:保存并恢复标签顺序、打开的会话以及分屏数量/比例（浏览器存储不保存密码和私钥）
- 会话管理:保存/编辑/删除,JSON 持久化(`%USERPROFILE%\.sshterm\sessions.json`)
- 双击左侧会话直接连接;悬停可编辑/删除
- 中文输入、256 色、滚动缓冲(5000 行)

## 复制粘贴(Xshell 习惯)

| 操作 | 效果 |
|---|---|
| 鼠标拖选文本 | **自动复制**(首次使用浏览器可能询问剪贴板权限,允许即可) |
| 右键点击终端 | 粘贴剪贴板 |
| Ctrl+Shift+C / Ctrl+Shift+V | 复制 / 粘贴 |
| Ctrl+C | 有选中文本 → 复制;无选中 → 照常发 SIGINT(中断命令) |
| Ctrl+V | 粘贴 |

## 使用

1. 点 **＋ 新建连接**(或 Ctrl+N),选类型填参数;
2. SSH:主机/端口/用户名/密码,或选密钥认证填私钥路径;
3. 串口:选 COM 口和波特率,勾 HEX 可十六进制收发;
4. **保存并连接** 存入左侧列表;**连接** 只连不存;
5. 多开:重复新建即可,相同配置自动复用连接。

### 分屏与工作区

1. 连接一个会话后点击 **分屏**，当前标签会增加一个相同配置的独立终端；再次点击可关闭附加分屏；
2. 拖动两个终端之间的分隔条可调整宽度；
3. 点击 **工作区 → 保存当前工作区**，保存标签、顺序及分屏布局；
4. 点击 **工作区 → 恢复已保存工作区**，关闭当前标签并重新建立保存的布局；
5. 工作区不会在浏览器中保存密码或私钥，未勾选“记住密码”的会话恢复时可能需要重新认证。

### 刷新页面

- `Ctrl+F5` 只重建浏览器界面，后台连接会保留 10 秒并由新页面重新挂接；
- 刷新期间产生的最近 256 KB 终端输出会在挂接后补发；
- 重新挂接不会再次执行“连接后执行”命令；
- 正常关闭所有页面超过宽限期后，后台连接会释放；服务进程重启、远端主动断开或网络中断无法通过页面刷新保留。

## 架构

```
浏览器 (xterm.js 渲染 + 多标签 UI)
   ↕ WebSocket (binary 数据流 + JSON 控制)
Node 服务端 (localhost:8787)
 ├─ ssh2      → SSH 会话
 ├─ net       → Telnet 会话
 └─ serialport→ 串口会话
会话持久化 → %USERPROFILE%\.sshterm\sessions.json
```

- 只监听 `127.0.0.1`,不对外暴露;
- 会话密码存本地 JSON(个人工具;返回前端时自动剥除敏感字段)。

## 目录

```
server/               Node 服务端
  index.js            入口: HTTP + WS + 连接管理
  connections/        协议插件 (base/ssh/telnet/serial)
web/                  前端 (index.html / app.js / style.css)
tests/                e2e 测试 (SSH/Telnet/串口)
perf-proto/           链路压测原型 (性能验证)
run.bat               前台启动/首次安装依赖/故障诊断
launcher.vbs          Windows 无窗口启动入口
launch.ps1            隐藏 Node、健康检查、打开浏览器及记录启动日志
```

## 已知边界

- 串口收发回环需对端设备(或安装 com0com 虚拟串口对,见下);
- 目录 ZIP 会跳过符号链接以及扫描后消失/无法读取的文件，并在进度与完成状态中显示跳过数量；
- 使用 `launcher.vbs` 时，所有浏览器页面关闭约 10 秒后后台服务自动退出；
- 使用 `run.bat` 时，关闭命令窗口即停止服务；
- 需要独立 exe 时,后续可用 Tauri/WebView2 套壳,核心不变。

### 串口回环验证(可选)

无真机时可用虚拟串口对验证收发:安装 [com0com](https://sourceforge.net/projects/com0com/) 后配对 COM28↔COM29,
一个标签连 COM28,另一个连 COM29,互发互收。

## 性能

实测(perf-proto/):串口 921600 全速、SSH 高速输出下,WS 链路延迟 <2ms、0 丢包;
xterm.js 渲染与 VSCode 终端同款,高速输出自动丢中间帧,UI 不冻结。
