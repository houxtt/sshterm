# 修复状态更新 2026-09-11

本段为**状态叠加层**，不改写下方 2026-09-07 历史审计正文。新同学请先看本表与仓库 [`docs/STATUS.md`](../STATUS.md)，勿将全部 38 项视为仍未处理。

| 编号 | 主题 | 2026-09-11 状态 | 说明 |
|---|---|---|---|
| F01 | 串口保存端口被改成 22 | 已修 | sanitizeSession 协议分型 + audit_regression |
| F02 | 保存丢失分组/认证字段 | 已修 | schema 白名单 + 回归 |
| F03–F07 | SFTP 上传/续传/close | 部分已修 | close 错误传播等；冲突策略仍可增强 |
| F08 | Zmodem Sentry 绕过输出 | **产品决策** | 移除浏览器 Sentry/consume；**明确未支持**用户确认收发 |
| F09 | GBK 浏览器收发 | 部分/相关已跟进 | encoding 模块 + 流式解码契约仍在 |
| F12 | 三至四分屏 | **已跟进** | 分屏按钮逐次加到 SPLIT_MAX=4（2×2）；双格拖拽保留 |
| F13 | 操作级 error 误关标签 | **已修** | 服务端 operational error 带 `action`；前端仅无 action 时 setTabState(closed)，有 action 时 setStatus |
| df/$3 总量 | 主机磁盘总量字段 | **已修** | `df -Pk` awk 总量改用 `$2*1024`（可用仍 `$4*1024`） |
| F15–F20 / F24 / F27 / F28 / F31 / F32 / F34 等 | 连接/传输/多窗口/背压等 | 多数已在 9/7 后提交中跟进 | 以源码与 `audit_regression` / static 契约为准；未在本叠加层逐条复验的仍看正文 |
| 其余 Fxx | 见正文 | 仍开放/未在本轮 | 请继续以历史正文为准逐项跟进 |

---

# sshterm 全面缺陷审计

审计日期：2026-09-07。基线提交：`16d3c48ec0733dc5b4932d9aacb13f287e0038ac`，**结论针对包含未提交修改的当前工作区，不只针对该提交**。文件摘要见 [source-manifest.json](source-manifest.json)。

本次仅新增审计报告和隔离复现脚本，未修复或改动产品源码。测试服务使用临时用户目录、随机本地端口和模拟设备，未对真实 SSH 主机、串口或 VNC 桌面执行操作。

## 结论

当前版本存在会导致**发送到错误设备、保存后配置失效、文件内容混合或错误跳过、连接与文件句柄泄漏**的缺陷，尚不适合作为无人值守自动化或重要文件发布的唯一工具。

此前“可靠性修复全部完成”的总结与当前源码不一致。当前保留了 Telnet 跨包解析、SFTP 初始化重试、隧道计数修复、OSC 7 跟踪及串口打开重试；但脚本输出水位、浏览器 GBK 收发、WebSocket 背压、SOCKS 已连接状态关闭超时、三分屏 DOM 修复等，当前工作区中没有对应的完整实现。

报告按 38 个问题组整理；同根因的多个表现合并记录。没有确认可供任意外部网页直接利用的无认证远程控制漏洞，因此不将本次发现标成此类 P0 漏洞。

- **P1**：数据完整性、误操作、核心功能或资源管理问题，应先于新增功能处理。
- **P2**：兼容性、恢复、诊断与交付问题，应纳入后续修复。
- **复现**：直接调用当前函数、真实浏览器或隔离服务观察到异常；不代表已覆盖所有设备。
- **源码确认**：明确的调用或状态缺口，但本次未执行对应真实场景。
- 风险与待验证事项另列，不能视为已复现故障。

## 1. 保存、发送及文件完整性

### F01 · P1 · 串口保存后端口被改成 22【复现】

位置：[server/index.js:1067](../../server/index.js#L1067)、[web/app.js:1624](../../web/app.js#L1624)。

`sanitizeSession()` 对所有协议统一执行 TCP 端口数值校验。`COM27` 转成数字失败后回退到 `22`；`port2` 又不在白名单。复现输入 `{type:'serial',name:'audit',port:'COM27',port2:'COM27'}`，结果为 `{type:'serial',name:'audit',port:22}`。首次“保存并连接”可能因使用浏览器原配置而成功，再次打开保存项却失效。

修复：协议分别定义配置结构；串口端口始终保持设备路径字符串；增加保存、加载、重启、再连接的完整往返测试。

### F02 · P1 · 保存会丢失分组、自动命令和认证参数【复现】

位置：[server/index.js:1071](../../server/index.js#L1071)、[server/index.js:1092](../../server/index.js#L1092)。

白名单缺少 `group/autoCmds/rtscts/hexMode/timestamp/trigger/viewOnly` 等 UI 已提供的字段。代理清理只留下主机、端口、密码，丢掉 `type/username`；跳板认证清理丢掉 `auth/username`。复现保存 SOCKS5 配置后类型消失，后续 `connectProxy()` 会走 HTTP 分支；跳板独立密钥认证也无法按原设置恢复。

修复：统一前后端配置 schema 和迁移规则；分别覆盖 SSH 代理、跳板、串口、VNC、分组及自动命令往返测试。

### F03 · P1 · 上传以文件大小判断相同，可能错误跳过或混合内容【复现】

位置：[web/app.js:3236](../../web/app.js#L3236)。

远端与本地同名且等长时直接返回 `skipped:true`，不读取或比较内容；远端较小时直接从其长度开始追加。复现等长文件时上传接口完全不被调用。若本地文件换了版本，最终文件可能是“旧前缀 + 新后缀”，却显示续传完成。SSH 的传输校验不能证明旧前缀属于同一个文件。

修复：默认覆盖或提供明确冲突选择；只有身份及前缀校验通过才允许续传；重要文件采用临时文件写入、完整校验和原子重命名。

### F04 · P1 · 定时发送会跟随激活标签，发往另一台设备【复现】

位置：[web/app.js:2078](../../web/app.js#L2078)。

定时器每次执行重新按 `activeTabId` 选择目标。复现：在标签 1 启动，切换标签 2 后，`DEVICE_COMMAND` 被发送给 2。关闭原标签也不会自然绑定停止。另外 HEX 输入未严格校验字节范围，超出范围会被 Uint8Array 截断。

修复：启动时固定连接 ID；关闭或断开目标时停止；工具栏明确显示发送目标、状态与停止按钮；拒绝非法 HEX 和过小间隔。

### F05 · P1 · SFTP 队列目标不是任务快照，可能中途变更【源码确认】

位置：[web/app.js:3268](../../web/app.js#L3268)、[web/app.js:3307](../../web/app.js#L3307)、[web/app.js:3361](../../web/app.js#L3361)。

逐文件上传和目录 worker 在每个文件开始时读取全局 `sftpConnId/sftpPath`。上传期间切换文件面板、进入其他目录或重新打开另一会话面板，会改变后续文件目标。拖拽上传还把激活标签 ID 与全局文件面板路径混用，首次使用 SFTP 时依赖固定 800ms 等待，未等待通道就绪。

修复：创建任务时冻结 `{windowId,connId,remoteDirectory,files}`；使用请求 ID 等待 SFTP 初始化；目标失效后失败退出，不选择新目标。

### F06 · P1 · 下载续传没有远端文件身份校验【源码确认】

位置：[server/index.js:842](../../server/index.js#L842)、[web/app.js:3113](../../web/app.js#L3113)、[web/app.js:3167](../../web/app.js#L3167)。

Range 重试缺少 ETag、版本或内容校验。远端文件在重试前被等长替换时，可拼出跨版本文件；小文件 Blob 路径还未像流式写盘路径一样检查 206 和最终字节数。传输通道 MAC/AEAD 不覆盖跨请求文件身份。

修复：记录 size/mtime 等基础身份，结合远端哈希或快照策略；续传要求身份匹配、206 和正确 Content-Range，最后校验长度与内容。

### F07 · P1 · 上传忽略远端关闭文件的错误【复现】

位置：[server/sftp-transfer.js:129](../../server/sftp-transfer.js#L129)。

`sftp.close(current, () => callback())` 丢掉错误。模拟远端返回 `remote flush failed`，上传仍成功返回 `{received:4}`。HTTP 返回的哈希来自收到的请求内容，而不是远端重新读取的数据，不能补足该缺口。

修复：传播 write/close 错误；失败任务不报成功；明确传输校验和远端内容校验的区别。

## 2. 终端、显示、编码和自动化

### F08 · P1 · Zmodem 分支绕过正常输出处理【真实浏览器复现】

位置：[web/app.js:260](../../web/app.js#L260)、[web/app.js:983](../../web/app.js#L983)。

页面默认加载 Zmodem，每个普通终端都创建 Sentry。收到输出后 `consume(payload); return`，回调仅执行 `term.write()`，绕过 HEX、时间戳、触发提示、抓包 RX、录制 events、recParts 和持久化调度。

实际页面：开启 HEX、抓包和录制，输入模拟输出 ABC，屏幕显示 `ABC` 而非 HEX；录制事件、缓存字数、抓包条目均为 0。同时 Zmodem 检测始终 `deny()`，也没有真正的文件收发确认入口。

修复：所有普通输出汇入单一处理函数，Sentry 的 `to_terminal` 也走该函数；Zmodem 传输单独建立用户确认和收发流程。当前不能描述为已支持可用的 Zmodem 文件传输。

### F09 · P1 · GBK 模块未接通浏览器收发，日志仍会跨包乱码【复现】

位置：[web/app.js:265](../../web/app.js#L265)、[web/app.js:301](../../web/app.js#L301)、[server/index.js:1642](../../server/index.js#L1642)、[server/encoding.js](../../server/encoding.js)。

当前输入依旧固定 `TextEncoder()`，服务端只导入 `decodeBuffer`，没有非 UTF-8 文本输入处理。GBK 会话发送“中”的帧为 `0100e4b8ad`，正确应为 `0100d6d0`。输出直接传 Uint8Array 给 xterm，其字节输入按 UTF-8 解释。

日志每包独立 `decode()`，未使用流式状态；“中”的 GBK 两字节或 UTF-8 三字节分包后，都复现为 `��`。`gb18030` 编码实际回用 GBK 表，亦不等于完整 GB18030；部分支持解码的 label 没有对应编码实现。

修复：每连接独立流式解码器；明确字符串与原始二进制的数据面；统一实际支持的编码集合，覆盖分包、别名及双向字节测试。

### F10 · P1 · 脚本仍可匹配历史输出，且执行状态跨会话共享【复现／源码确认】

位置：[web/app.js:2165](../../web/app.js#L2165)、[web/app.js:2185](../../web/app.js#L2185)、[web/app.js:2204](../../web/app.js#L2204)。

当前仍搜索整个 `tab.recParts`。预置 `OLD_SUCCESS` 后，尚无新输出就发送下一条命令，已复现；默认 Sentry 分支又不更新 recParts，另一种表现是一直超时。`_scriptRun` 为全局变量，一个会话启动脚本会取消另一个。自动命令根据 activeTabId 寻找刚连接的会话，后台标签连接完成时会跳过执行。

修复：每连接独立运行实例、输出序号和结果状态；发送后只消费新输出；自动命令绑定连接事件中的目标；校验正则并限制匹配成本。

### F11 · P2 · 图片辅助命令不可用且残留远端输入【真实浏览器／函数复现】

位置：[web/app.js:60](../../web/app.js#L60)、[web/app.js:109](../../web/app.js#L109)。

已安装 ImageAddon 对象没有 `registerImage` 方法，实际页面返回 `undefined`。输入拦截又先把 `display /tmp/a.png` 字符发送到远端，仅拦截回车，远端命令行并未清空，下一次输入会接在其后。路径按空格切割，不能正确处理带空格或引号的文件名；取图依赖已经建立的 SFTP 子系统。

修复：使用实际支持的图片接口；优先使用独立图片操作入口；若拦截命令，必须有可靠 Shell 集成，不能只猜测按键文本。

### F12 · P2 · 三至四分屏依然抛异常，pane 能力不完整【真实浏览器复现】

位置：[web/app.js:2397](../../web/app.js#L2397)、[web/app.js:2479](../../web/app.js#L2479)。

三屏分支将 pane 对象当作 DOM 元素访问 `style`；调用两次 addPane，实际报 `Cannot set properties of undefined (setting 'flex')`。普通按钮仅双屏/关闭切换。附加 pane 无独立 SearchAddon，搜索和命令操作主要指向主标签；附加连接断开也未进入主标签自动重连分支。

修复：统一 Pane 模型和当前焦点；布局、搜索、复制、重连、录制、命令路由都按 pane 测试。

### F13 · P2 · 普通操作错误会把健康终端标记成断开【真实浏览器复现】

位置：[web/app.js:476](../../web/app.js#L476)。

统一 error 消息总是对主标签执行 `setTabState(...,'closed')`。模拟 `SFTP: permission denied` 后，终端状态由 connected 变成 closed。此时实际 SSH 可能仍活跃，但文件、命令等按钮被禁用，关闭确认也可能被跳过。

修复：区分连接错误与操作错误；操作响应带 requestId/action，不改变连接状态。

### F14 · P2 · 抓包格式、内存和对象生命周期有缺口【源码确认】

位置：[web/app.js:1019](../../web/app.js#L1019)、[web/app.js:1159](../../web/app.js#L1159)、[web/app.js:2889](../../web/app.js#L2889)。

抓包使用 `new Blob([tab.captureParts || []])`，数组会转成逗号拼接字符串，而非按记录直接拼接。captureParts 无大小上限。ResizeObserver 保存在局部变量，关闭标签不调用 disconnect；主机信息轮询仅在关闭标签时停止，在远端断开时仍继续请求。结合长期多标签使用会增加无效工作与资源保留。抓包 RX 另受 F08 影响。

修复：抓包分块落盘或设置可见上限；明确输出格式；集中管理每标签 observer、timer、流和录制的 dispose。

## 3. 连接生命周期与协议

### F15 · P1 · SSH 在 ready 前关闭，connect Promise 不结束【复现】

位置：[server/connections/ssh.js:247](../../server/connections/ssh.js#L247)、[server/ssh-connect-scheduler.js](../../server/ssh-connect-scheduler.js)。

当 client 在认证就绪前只发 close，状态会变成 closed，但 Promise 既不 resolve 也不 reject。模拟此事件已确认 pending。按服务器串行握手的调度器会一直占用该端点，后续同主机连接一直排队。

修复：建立统一且只执行一次的 finishConnect；error/close/cancel/timeout 都必须结束 Promise 并释放调度器。

### F16 · P1 · SSH 远端关闭和失败路径没有完整清理【复现／源码确认】

位置：[server/connections/ssh.js:222](../../server/connections/ssh.js#L222)、[server/connections/ssh.js:561](../../server/connections/ssh.js#L561)、[server/index.js:1705](../../server/index.js#L1705)。

远端关闭先调用 `_emitClose()` 将 state 设为 closed；之后 `close()` 直接返回，不再关闭本地隧道监听和跳板连接。模拟远端关闭后，隧道 close 调用次数为 0。doConnect 的 catch 删除 Map 条目，但没有统一 dispose；shell 打开失败、跳板链中途失败等可能遗留连接或日志流。

修复：状态通知与资源释放分离；任何结束路径都调用幂等 dispose，覆盖所有已创建和正在创建的资源。

### F17 · P1 · 取消串口建连后仍会打开设备【复现】

位置：[server/connections/serial.js:80](../../server/connections/serial.js#L80)、[server/connections/serial.js:132](../../server/connections/serial.js#L132)。

close() 在 open 或重试尚未结束时只更新状态；open 成功后不检查取消标记，直接重新设 connected。模拟先 close 再触发 open 成功，结果为 `connected` 且 deviceOpen=true，用户关闭标签后设备仍可被占用。

修复：取消令牌、打开代次检查、取消重试；迟到的 open 成功回调必须关闭该句柄。

### F18 · P1 · HTTP CONNECT 代理会丢失与响应粘包的 SSH banner【本地 TCP 复现】

位置：[server/connections/proxy.js:98](../../server/connections/proxy.js#L98)。

HTTP 头与首段目标数据合并读取时，握手代码只找头结束，剩余字节被丢弃。模拟代理一次写入 `HTTP/1.1 200 ...\r\n\r\nSSH-2.0-audit\r\n`，调用者收到的 banner 为空。SOCKS5 分支也需要检查握手后的剩余数据交接。

修复：以字节方式解析并保留头后数据；在交接前 pause，unshift 剩余内容后由 SSH 接管；清理成功和失败时的 timer/listener。

### F19 · P1 · SOCKS 动态隧道仍在空闲 15 秒后断开【本地 TCP 复现】

位置：[server/connections/ssh.js:494](../../server/connections/ssh.js#L494)、[server/connections/ssh.js:501](../../server/connections/ssh.js#L501)。

成功转发后没有 `socket.setTimeout(0)`。完成 SOCKS 握手后不发送业务数据，本次在约 15015ms 后连接被关闭。

修复：仅对握手阶段计时；已建立连接使用单独可配置策略。增加空闲长连接行为测试。

### F20 · P1 · 多条远端隧道监听器相互拒绝连接【复现】

位置：[server/connections/ssh.js:438](../../server/connections/ssh.js#L438)。

每条远端隧道都订阅同一个 `tcp connection` 事件，不匹配自己的目标端口就执行 reject。创建两条隧道后，第二条的连接会被第一条监听器拒绝，已复现不相关 handler 的拒绝行为。

修复：每个 SSH Client 只有一个分发器；找到唯一目标后 accept，无匹配才 reject。

### F21 · P2 · 删除隧道未终止既有连接，监控状态不足【源码确认】

位置：[server/connections/ssh.js:408](../../server/connections/ssh.js#L408)、[server/connections/ssh.js:536](../../server/connections/ssh.js#L536)。

只关闭监听 server，没有保存活动 socket/stream 集合；`_remoteStream` 未在建立转发时赋值。因此删除主要停止接收新连接，已有流可继续活动。state 与 lastError 大多是初始化值，失败未形成完整可见状态；add/remove 响应缺少 tunnels 数组时，前端暂时显示“暂无隧道”。

修复：跟踪活动流并明确“停止监听”与“关闭隧道”语义；实时更新状态，操作后取权威列表。

### F22 · P2 · Telnet 分包修复后仍有协议兼容性缺口【复现／源码确认】

位置：[server/connections/telnet.js:79](../../server/connections/telnet.js#L79)、[server/connections/telnet.js:131](../../server/connections/telnet.js#L131)。

已修复部分 IAC 跨包，但仍拒绝服务端 WILL ECHO，客户端又没有相应本地回显策略；发送数据 0xFF 未转义；NAWS 宽度 255 的子协商也未将 255 加倍，均有字节复现。无限不结束的 SB 会不断扩展 `_buf`。密码提示晚于 2.5 秒会被自动登录兜底提前关闭。

修复：按协商状态处理 ECHO/SGA/NAWS，统一输出 IAC 转义，限制子协商缓冲；登录使用明确超时状态机。协议依据：[RFC 1073](https://datatracker.ietf.org/doc/html/rfc1073)。

### F23 · P2 · MFA 界面与实际支持不一致【源码确认】

位置：[server/connections/ssh.js:19](../../server/connections/ssh.js#L19)、[web/index.html:146](../../web/index.html#L146)。

keyboard-interactive 只为 password/passcode 等提示自动填已有密码，其他提示填空，没有将验证码或多轮挑战交给用户的流程。`passcode` 可能实际指 OTP。Agent 后面的 FIDO2 标签也不能代替具体系统 Agent 和密钥类型的兼容性验证。

修复：建立挑战/响应消息和可取消 UI；分别声明密码认证、OTP、Agent 与硬件密钥支持范围。

## 4. 文件传输资源与完整性

### F24 · P1 · 并行读的乱序缓存实际上无固定窗口上限【复现】

位置：[server/sftp-transfer.js:71](../../server/sftp-transfer.js#L71)。

只限制 pending 请求数，没有把 results 内等待顺序输出的块计算在窗口内。首块迟迟不返回时，后续块不断完成、不断补发，直至读完文件。复现 concurrency=2，却发出 100 个请求并缓存 99 块；大文件可累积接近整文件内存。

修复：限制 `pending + results.size` 或按 nextOutput 控制固定字节窗口；覆盖首块迟到、部分请求挂起、下游慢读和取消。

### F25 · P2 · 下载在 open 完成前取消会泄漏远端文件句柄【复现】

位置：[server/sftp-transfer.js:36](../../server/sftp-transfer.js#L36)、[server/sftp-transfer.js:89](../../server/sftp-transfer.js#L89)。

destroy 发生时尚无 handle，_destroy 直接返回；迟到的 open 回调仍赋值 handle，没有检查 destroyed。复现 close 调用次数为 0，destroyed stream 仍持有 handle。

修复：open 回调发现已取消立即关闭新句柄；完成后的 read 回调也应检查 destroyed，不能继续填 results。

### F26 · P2 · 目录 ZIP 会静默漏掉不可读目录和空目录【复现／源码确认】

位置：[server/connections/ssh.js:333](../../server/connections/ssh.js#L333)、[server/index.js:671](../../server/index.js#L671)。

目录 readdir 报错或超时转换成 null 并 continue，不记录 skipped。模拟根目录 permission denied，结果直接为空文件列表。扫描只收集文件，没有空目录条目，所以 ZIP 不保留空目录。现有 skipped 计数覆盖符号链接和扫描后的不可读文件，不能覆盖整个扫描阶段。

修复：扫描返回目录条目和问题清单；区分空目录与扫描失败；根目录不可读应失败，子目录跳过应显式报告。

## 5. 多窗口、恢复与本地服务

### F27 · P1 · 多窗口共享标签存储，恢复列表互相覆盖【真实浏览器复现】

位置：[web/app.js:200](../../web/app.js#L200)、[web/app.js:809](../../web/app.js#L809)。

windowId 在 sessionStorage，标签列表却统一写 localStorage 的 `sshterm.tabs`。两个实际页面同时打开，A 可见 WINDOW_A，B 保存后 A 的恢复数据变成 WINDOW_B。后台已有窗口隔离并不能隔离浏览器恢复列表。

另外，新浏览器页面关闭后再打开通常得到新的 sessionStorage windowId；旧连接默认无限保留，无法仅凭共享列表保证重新挂接原连接，可能新建连接并遗留旧连接。

修复：按 windowId 保存标签快照；区分共享工作区模板与窗口运行状态；提供可列出、接管和关闭的后台会话管理。

### F28 · P2 · 浏览器 WS 无自动恢复，断线恢复策略不完整【源码确认】

位置：[web/app.js:214](../../web/app.js#L214)、[web/app.js:239](../../web/app.js#L239)、[server/index.js:48](../../server/index.js#L48)。

只构造一次 WebSocket，onclose 只更新 UI；服务重启或连接断开后没有重新获取 token 和重新建立 WS。后端 detached 默认永久保留，缺少会话总数限制与管理入口。256KB 输出重放不是完整终端屏幕状态，截断控制序列、交互 TUI、超长图片和更早输出不能保证恢复。

修复：WS 状态机、退避重连、重新授权和稳定会话接管；有界后台会话策略；终端状态恢复应区分重放数据与完整屏幕快照。

### F29 · P2 · 只读录制回放在刷新后可能转成真实连接【真实页面配置复现／源码确认】

位置：[web/app.js:857](../../web/app.js#L857)、[web/app.js:2951](../../web/app.js#L2951)。

回放用普通 SSH cfg 创建标签，仅当次传 connect:false；saveTabs 不保存该标志，restoreTabItems 总是 connect:true。实际保存的回放配置包含主机，却没有只读/回放类型标记。如果匹配本地已保存会话，恢复还可能补回凭据并执行正常连接自动命令。未对真实目标执行此连接。

修复：回放使用独立类型和只读终端，不进入远端连接保存/恢复流程。

### F30 · P2 · 重复启动失败仍覆盖活跃服务令牌【隔离服务复现】

位置：[server/index.js:118](../../server/index.js#L118)、[server/index.js:125](../../server/index.js#L125)。

写 token 文件发生在成功监听端口之前。同用户、同端口再启动第二进程，第二进程因端口冲突退出，但 token 文件已被替换。复现第二进程 exit=1，文件 token 与活跃服务不一致，使用文件 token 请求 bootstrap 返回 403。已有浏览器内存 token 通常仍有效，故不能误报所有页面立即掉线。

修复：在成功获取实例锁/监听之后发布 token；按实例或端口隔离状态；停止与启动器验证同一实例。

### F31 · P2 · OpenSSH 导入把 Match 内规则错误应用到前一 Host【复现】

位置：[server/session-backup.js:77](../../server/session-backup.js#L77)、[server/index.js:419](../../server/index.js#L419)。

导入忽略 Match 行，却继续处理后面的 User 等字段。复现普通 Host 的 User normal，被 Match 区块中的 User root 覆盖。界面声称跳过 Match，不符合实际行为。另有两套解析器，Host 多别名、通配符默认项、Include 和别名跳板的处理不同。

修复：明确跳过整个不支持的区块并报告；合并解析器，建立 OpenSSH 配置语义测试。

## 6. 资源、安全边界及运维

### F32 · P1 · 当前终端、VNC 和串口发送缺少完整背压【源码确认】

位置：[server/index.js:1174](../../server/index.js#L1174)、[server/index.js:1042](../../server/index.js#L1042)、[server/connections/serial.js:99](../../server/connections/serial.js#L99)。

当前源码直接 ws.send；没有检查 bufferedAmount 或暂停上游。日志 write 返回值也未使用；串口 _writeQueue 无字节上限；VNC 双向直接 write/send。单帧 8MB 限制与 256KB 重放缓冲不限制持续发送队列。

修复：按连接管理高低水位、消费者确认、暂停与恢复；对不可可靠暂停的设备明确溢出策略和丢失计数。避免丢任意终端字节导致 ANSI 状态或 Zmodem 协议损坏。本次未进行多小时压力测试。

### F33 · P2 · 日志错误被全局兜底吞掉，日志生命周期和隐私策略不足【复现／源码确认】

位置：[server/index.js:1628](../../server/index.js#L1628)、[server/index.js:227](../../server/index.js#L227)、[server/dpapi.js:58](../../server/dpapi.js#L58)。

日志 WriteStream 没有局部 error 处理。模拟目录不可写，触发 uncaughtException 日志，服务仍存活但用户看不到日志写入失败；**不能据此声称进程已崩溃**。文件名只精确到秒，同名并发连接可写进同一日志；只在启动时按数量/年龄清理，没有单文件大小或总空间预算。所有终端输出默认明文落盘，远端回显的敏感内容并不受 DPAPI 保护。

另外保存全部凭据使用同步 PowerShell、无超时，可能阻塞同一 Node 事件循环；元数据与凭据分别替换，不构成共同事务。

修复：每连接唯一日志 ID、可配置保存和脱敏策略、滚动与空间预算、局部错误可见；凭据 I/O 异步化并设置超时和一致性提交机制。

### F34 · P1 · 强制释放串口可能匹配多个设备【源码确认，未执行设备操作】

位置：[server/free-serial.ps1:7](../../server/free-serial.ps1#L7)、[server/index.js:1364](../../server/index.js#L1364)。

设备查询使用 `Name -match $ComPort`，请求 COM1 可匹配含 COM10、COM11 等名称，随后将匹配结果的 PNPDeviceID 传给 Disable/Enable。外层 Start-Process 未读取被提权脚本 ExitCode，子进程失败也可能被报告“已释放”。

修复：精确匹配设备 ID 或完整 `(COM1)` 标记，展示唯一设备后执行；传回实际退出码并验证设备状态。不能为验证此问题去重启用户设备。

### F35 · P2 · VNC 建连取消与目标策略不完整【源码确认】

位置：[server/index.js:1002](../../server/index.js#L1002)、[server/index.js:1031](../../server/index.js#L1031)。

WS 在 TCP connect Promise 完成前关闭时，closeStream 看不到尚未赋值的 stream；连接稍后成功后没有重新检查 WS 状态，可遗留 TCP 连接。私网策略只校验直接输入的 IPv4，域名解析结果和 IPv6 不走等价校验，不符合“仅私网”的代码声明。这里只是已授权 token 客户端的策略缺口，不是无认证扫描漏洞。

修复：建连可取消、迟到结果立即销毁；若保留私网限制，解析并校验最终目标地址；同时补双向流量控制。

### F36 · P2 · WS 输入和错误处理依赖全局异常兜底【隔离服务复现】

位置：[server/index.js:980](../../server/index.js#L980)、[server/index.js:1207](../../server/index.js#L1207)。

JSON `null` 在错误回调再次读取 m.id 时触发 unhandledRejection；超过 8MB 帧触发未局部处理的 WS error，进入全局 uncaughtException。进程本次均继续存活。connect/resize 等消息缺少统一 schema，连接 ID 也没有统一约束到二进制协议的 16 位范围。

修复：消息入口先校验对象、类型、ID、长度和字段；每条 WS 有 error/close 清理；给调用者确定响应，避免靠全局捕获维持不明确状态。

## 7. 测试、发布和文档

### F37 · P1 · 测试未覆盖真实链路，部分测试已与鉴权实现脱节【实测】

位置：[package.json](../../package.json)、[tests/static_security_contract.js](../../tests/static_security_contract.js)、[tests/integration_sftp_transport.js:29](../../tests/integration_sftp_transport.js#L29)、[.github/workflows/ci.yml](../../.github/workflows/ci.yml)。

`npm run check` 的 3 个语法检查通过，但在翻译覆盖测试失败：`双击编辑配置 · 或单击编辑按钮` 未翻译。补跑短路后未执行的 5 项均通过，故本次静态/契约套件合计 **16 通过、1 失败**。

大量检查只检查字符串存在。例如 encoding 模块单测通过，却未接入终端收发；Zmodem、录制、隧道契约测试通过，也未发现真实页面/空闲连接故障。

`integration_sftp_transport.js` 启动隔离服务后，无 Origin/CLI token 获取 bootstrap，实际得到 403，未进入传输断言。多个其他集成测试存在同类调用模式。`e2e_token_origin.js` 虽接受 URL 参数，部分 Origin 仍写死 8799，在随机端口检查出现 5 通过、2 失败，属于测试参数缺陷。

CI 列举旧测试列表，没有统一调用最新 test:static；某些独立测试未隔离 USERPROFILE/HOME，会覆盖开发者 token 或读取真实会话。`npm test` 包含真实设备固定地址，不适合未经环境准备直接作为通用验证。

修复：安全临时 profile、随机端口和统一认证 helper；以实际字节、磁盘结果、生命周期与跨模块 UI 行为断言为主；CI 与 package scripts 共用清单。

### F38 · P2 · 打包、启动及文档不能证明当前可发布【源码确认】

位置：[scripts/build-exe.js](../../scripts/build-exe.js)、[tests/smoke_packaged_exe.js](../../tests/smoke_packaged_exe.js)、[.github/workflows/release.yml](../../.github/workflows/release.yml)、[README.md](../../README.md)、[docs/DESIGN.md](../DESIGN.md)。

- caxa 不在锁定依赖中，构建时使用 npx 或全局安装，工具版本不可复现；打包排除 `*.ps1` 与串口释放依赖 `free-serial.ps1` 存在冲突，需验证实际产物内容。
- EXE smoke 只检查 HTTP 页面，未验证串口原生模块、DPAPI、VNC、SFTP 或签名后运行；测试未使用隔离 profile。
- Release 只运行少量检查，version 输入未与 package 版本进行程序比较；目前只能确认“有构建与签名工作流”，不能确认当前产物通过全功能验收。
- `run.bat` 以 curl 成功作为复用服务条件，没有验证应用身份；仅凭 node_modules 存在判断依赖已安装。
- README 仍称关闭页面 10 秒释放连接，而当前默认不释放；设计文档仍写明文凭据、后续才打包等过期描述；旧规划将已有隧道/搜索/分组列为缺失；“低延迟、零丢包、自动丢中间帧”的说法没有当前版本完整证据。

修复：锁定构建工具，检查运行时资源清单和签名后产物，统一版本校验；以当前基线更新文档，性能指标同时记录硬件、负载、时长、内存及丢失统计。

## 8. 已检查但仍需专项验证的风险

以下不计入上述已确认问题组的故障数量，也不据此宣称已经发生数据泄漏或崩溃：

1. SSH 跳板中途取消、代理失败后清理、上游 client 后续 error，以及同时创建隧道的 8 条上限竞争，需要真实 SSH fixture 的完整生命周期测试。
2. 下载取消主要监听 req.aborted，需验证浏览器在 HTTP 请求已完成后取消响应时，res.close 是否仍触发远端读取停止；扫描阶段取消也应传播到扫描器。
3. 文件上传锁键为 `conn.id + path`，既没有窗口命名空间，也不是规范化后的远端对象；可能误阻止不同窗口相同 ID 的上传，或无法拦截不同会话写同一文件。
4. Windows 私钥路径白名单没有 realpath/reparse-point 验证；本次没有构造链接绕过或读取真实密钥。凭据跨用户保护和目录 ACL 需要专门验证。
5. known-hosts JSON 非原子替换，损坏时按空表处理；主机密钥更新、算法变化及备份恢复缺少管理流程。
6. SSH 主机统计的 df 命令将已用块 `$3` 当 total，而标准 df 的总块在 `$2`；需要 Linux/BusyBox/macOS 样本对照，当前不可依赖其容量数值做决策。
7. 停止脚本仅信任 localhost 返回的 app/PID，没有额外核对端口所有者、进程路径与启动时间；需评估 PID 复用或本地伪装服务的边界。
8. 多小时串口持续输出、USB 拔插、磁盘满、电脑睡眠恢复、复杂 TUI/图片序列、超大目录及高延迟链路未进行长时间设备测试。

## 9. 不应混同为缺陷的功能缺口

当前文件面板主要完成浏览与传输，未形成完整的重命名、删除、权限、远端编辑与目录同步工作流。SSH 文件管理辅助函数的存在不等于 UI 和消息路由已接通。

后续功能可按定位选择：完整 SFTP 文件管理、可靠 MFA、多会话广播与环境标识、完善多分屏、设备身份识别及 USB 热插拔、PowerShell/CMD/WSL、本地命令面板、RDP/X11、主题与按键配置、成熟会话格式迁移。它们均不应优先于误发命令和文件完整性修复。

## 10. 验证清单与可复现证据

| 验证 | 本次结果 | 结论边界 |
|---|---|---|
| npm run check | 失败 | 3 项语法检查通过；i18n 短路失败 |
| 补跑 test:static 后续检查 | 通过 | static 清单合计 16/17 通过，不代表完整端到端 |
| npm audit --omit=dev --json | 已知漏洞 0 | 包审计不能证明应用逻辑安全 |
| tests/integration_sftp_transport.js | bootstrap HTTP 403 | 测试鉴权过期，未执行传输验证 |
| tests/sftp_parallel_transfer.js | 通过 | 基本并行顺序和偏移正确，未覆盖首块挂起 |
| tests/split_connection_config.js | 通过 | 仅凭据克隆函数范围 |
| tests/ui_large_download_stream.js | 浏览器启动失败 | 报 profile already running，本次不归因为产品功能失败 |
| tests/ui_split_workspace.js | 浏览器启动失败 | 同上；另以自定义独立 profile 浏览器复现分屏问题 |
| tests/e2e_token_origin.js + 随机端口 | 5 通过 / 2 失败 | 两处 Origin 固定 8799；无 Origin/恶意 Origin 拒绝和正确 CLI token 通路通过 |
| 实际浏览器自定义探针 | 已执行 | HEX/录制缓存、图片 API、错误状态、三屏、多窗口存储 |
| 本地三文件 ZIP 样例 | 通过 | 三个 2MiB 文件均可解包且长度正确；本次未把这个疑点判定为 ZIP 丢数据 |
| 真机、完整 npm test、EXE 构建/签名 | 未执行 | 避免操作实际设备；不声明通过 |

复现入口（应在独立测试环境运行；不与开发者服务共享用户目录）：

```powershell
node docs/audit-2026-09-07/probes.cjs
node docs/audit-2026-09-07/lifecycle-probes.cjs
node docs/audit-2026-09-07/ui-probes.cjs
```

脚本结果采用观察记录，不以“已知缺陷触发”为测试失败退出码；将来修复后应将期望行为转成正式 assert 回归测试。

- [基础与真实页面结果](probe-results.json)
- [连接、传输及代理结果](lifecycle-results.json)
- [定时发送与多窗口结果](ui-results.json)

补充技术依据：[xterm 字节编码](https://xtermjs.org/docs/guides/encoding/)、[Node 流与错误处理](https://nodejs.org/api/stream.html)。本次功能判断主要来自本地源码和隔离执行，不来自旧功能对比表。

## 11. 建议修复顺序

1. **先保护操作对象和数据**：F01–F07、F17、F27、F34；特别是串口保存、定时发送目标、上传覆盖/续传与任务目标冻结。
2. **统一终端数据面和连接状态**：F08–F10、F13、F15–F20、F32；让显示、缓存、录制、编码、脚本共享同一条正确链路。
3. **补传输资源与恢复闭环**：F21、F24–F26、F28–F31、F33、F35–F36。
4. **完善界面兼容性和交付**：其余功能问题，随后统一 CI、打包验收及文档。每个修复都必须覆盖跨模块真实行为，不能只检查关键字是否存在。
