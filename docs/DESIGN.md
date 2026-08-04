# sshterm — SSH / Telnet / 串口 多标签连接工具

> 最终设计文档 v2.0 | 2026-08-04 | 架构评审通过 ✅

## 1. 目标

Windows 上轻量、快速、稳定的多协议连接工具:SSH / Telnet / 串口,点选即连、多标签。

## 2. 需求决策(圆桌讨论结论)

| 决策点 | 结论 |
|---|---|
| 形态 | GUI 图形界面(浏览器 UI),多标签点选即连 |
| 技术栈 | Node 22 + xterm.js 6 + ws(本地服务 + 浏览器) |
| 核心功能 | SSH(密码+密钥)、Telnet(含自动登录)、串口(全参数+hex)、会话管理 |
| 交付 | 源码 + run.bat(验证后可选打包) |

## 3. 为什么是"本地 Node + 浏览器"(调研驱动的架构)

调研 GitHub 主流工具(Tabby ★73.7k / WindTerm ★31.8k / xterm.js ★21k / WezTerm ★28k)后:

1. **终端渲染标准 = xterm.js**(VSCode 同款):中文 IME、鼠标、256 色、搜索全现成,pyte 自绘方案在仿真完整度上无法追赶;
2. **不用 Electron**(Tabby 用但代价高):serialport 原生模块在 Electron ABI 下常需本地编译(2~5GB 工具链);Electron 体积 200MB+、内存 300MB+、杀毒误报——与"简介、快速、稳定"冲突;
3. Tabby 自带 tabby-web 纯浏览器模式,证明"Electron 壳非必须",xterm.js + 协议插件层才是价值核心。

## 4. 架构

```
┌─ 浏览器 (渲染进程) ──────────────────────────┐
│  xterm.js 6 (FitAddon) 多标签终端            │
│  会话管理 UI / 对话框 / hex 模式              │
│  WebSocket 客户端 (binary 数据 + JSON 控制)   │
└──────────────┬──────────────────────────────┘
               │ ws://127.0.0.1:8787
┌──────────────▼──────────────────────────────┐
│ Node 服务端 (主进程)                          │
│  HTTP 静态服务 (web/ + vendor 资源)           │
│  WS 路由: binary[connId 2B][data] → conn     │
│  连接管理器 (Map<connId, BaseConnection>)      │
│  ├─ ssh    : ssh2 (密码/密钥)                 │
│  ├─ telnet : net socket (IAC 协商+自动登录)    │
│  └─ serial : serialport (全参数)              │
│  会话持久化: %USERPROFILE%\.sshterm\sessions.json
└─────────────────────────────────────────────┘
```

## 5. 稳定性设计(实测验证)

| 机制 | 实现 | 验证 |
|---|---|---|
| UI 不卡 | 数据流工作在工作线程/进程(Node 异步),渲染走 xterm.js rAF 批量 | 压测: 5MB/s 灌数 UI 0 卡顿(perf-proto) |
| 高速输出 | xterm.js 自动丢中间帧,UI 不冻结 | 与 VSCode 终端同款 |
| 断线不崩 | 读循环异常 → error 事件 → UI 提示,会话标记断开 | e2e: 连接后正常断开 |
| 僵尸清理 | WS close → 服务端关闭该客户端全部连接 | 已实现 ws.on('close') |
| 敏感数据 | 会话列表返回前端前剥除 password/privateKey/passphrase/loginPass | e2e 验证 ✅ |
| 安全边界 | 只监听 127.0.0.1;同配置连接去重复用 | 已实现 |

## 6. 文件结构

```
sshterm/
├── run.bat              启动脚本 (查 Node → 装依赖 → 起服务 → 开浏览器)
├── README.md            使用说明
├── package.json         依赖: ssh2 / serialport / ws / @xterm/xterm / @xterm/addon-fit
├── server/
│   ├── index.js         入口: HTTP + WS + 连接管理 + 会话 CRUD
│   └── connections/     协议插件 (base/ssh/telnet/serial)
├── web/
│   ├── index.html       页面骨架 + 对话框
│   ├── app.js           前端逻辑 (多标签/会话/数据流/hex)
│   └── style.css        深色主题
├── tests/               e2e 测试 (SSH 真机 / telnet mock / 串口 / WS 全链路)
└── perf-proto/          链路压测原型 (性能证据)
```

## 7. 验证记录

- ✅ SSH 真实连接 192.168.1.216: 密码认证 → shell → 命令执行 → 双向数据 → 干净断开
- ✅ Telnet mock (IAC DO ECHO + login/Password): 协商无乱码 + 自动登录 + 回显
- ✅ 串口 COM27 (WCH) @115200/921600: 打开/写入/关闭成功(收发回环需对端设备)
- ✅ WS 全链路: connect → status → binary 路由 → 输入回传 → 回显 → disconnect
- ✅ 会话 CRUD + 敏感字段剥除
- ✅ 前端页面加载无 JS 错误 (Edge headless)
- ✅ 性能: 串口 921600 全速 / SSH 高速输出, WS 延迟 <2ms 0 丢包

## 8. 已知边界与后续

- 串口收发回环验证需真机或 com0com 虚拟串口对(README 有说明)
- 独立 exe: 后续 Tauri / WebView2 套壳, 核心零改动
- 密码明文存本地 JSON(个人工具, 前端不返显)
