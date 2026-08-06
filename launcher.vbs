' sshterm launcher - hidden start
' double-click or desktop shortcut
Set ws = CreateObject("WScript.Shell")
ws.Run """C:\Users\Administrator\sshterm\run.bat"" --auto-exit", 0, False
