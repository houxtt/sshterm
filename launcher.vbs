' sshterm launcher - hidden start
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
script = base & "\launch.ps1"

If Not fso.FileExists(script) Then
  MsgBox "Launcher script not found: " & script, 16, "sshterm"
  WScript.Quit 1
End If

ws.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
