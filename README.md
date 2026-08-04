# sshterm — SSH / Telnet / 串口 多标签连接工具

轻量、快速的 Windows 连接工具:点选即连,多标签同时管理 SSH / Telnet / 串口会话。
浏览器界面(xterm.js 渲染,与 VSCode 终端同款),本地 Node 服务承载连接。

## 快速开始

```bat
run.bat          :: 双击运行(首次自动装依赖, 自动开浏览器)
```

或手动:

```bash
npm install      # 首次
node server/index.js
# 浏览器打开 http://127.0.0.1:8787
```

## 功能

| 协议 | 支持 | 说明 |
|---|---|---|
| SSH | 密码 / 密钥认证 | 交互式 shell,支持 resize |
| Telnet | 基本 + 自动登录 | IAC 协商,login/Password 自动填充 |
| 串口 | 全参数 + HEX 模式 | COM 口自动枚举,波特率至 921600 |

- 多标签:每标签一个连接,随时切换/关闭
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
```

## 已知边界

- 串口收发回环需对端设备(或安装 com0com 虚拟串口对,见下);
- 关浏览器后服务自动清理连接;关闭 run.bat 窗口即停止服务;
- 需要独立 exe 时,后续可用 Tauri/WebView2 套壳,核心不变。

### 串口回环验证(可选)

无真机时可用虚拟串口对验证收发:安装 [com0com](https://sourceforge.net/projects/com0com/) 后配对 COM28↔COM29,
一个标签连 COM28,另一个连 COM29,互发互收。

## 性能

实测(perf-proto/):串口 921600 全速、SSH 高速输出下,WS 链路延迟 <2ms、0 丢包;
xterm.js 渲染与 VSCode 终端同款,高速输出自动丢中间帧,UI 不冻结。
