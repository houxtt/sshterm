' sshterm launcher - 无窗口启动 (像应用程序)
' 用法: 双击本文件 或 桌面快捷方式指向本文件
Set ws = CreateObject("WScript.Shell")
ws.Run """C:\Users\Administrator\sshterm\run.bat"" --auto-exit", 0, False
