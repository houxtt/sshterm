# sshterm v2.0.0

- 新增 Windows 原生桌面窗口，双击 `sshterm.exe` 即可使用，无需浏览器。
- 应用界面和终端消息在进程内传递，不启动本机 HTTP/WebSocket 监听端口。
- 终端底部新增随会话切换的快捷命令栏，可一键运行已保存命令，也可输入命令按 Enter 发送。
- 保留现有 SSH、Telnet、串口、VNC、SFTP、会话管理和 DPAPI 凭据数据。

快捷命令仍通过“⚡ 命令”管理，按主机分别保存。v1 浏览器版的会话配置仍在 `%USERPROFILE%\.sshterm`；浏览器 localStorage 中的快捷命令不会自动转移到新的桌面应用存储，需要在桌面版重新添加。
