' sshterm safe stop launcher - double-click to stop only the verified local service
Option Explicit

Const LauncherInfoUrl = "http://127.0.0.1:8787/launcher-info"

Dim http, body, re, matches, processId, isDryRun, isElevated, isConfirmed, requestError
isDryRun = WScript.Arguments.Named.Exists("dryrun")
isElevated = WScript.Arguments.Named.Exists("elevated")
isConfirmed = WScript.Arguments.Named.Exists("confirmed")

On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
http.SetTimeouts 1000, 1000, 1000, 2000
http.Open "GET", LauncherInfoUrl, False
http.Send
If Err.Number <> 0 Then
  requestError = Err.Description
  Err.Clear
  On Error GoTo 0
  If isDryRun Then
    WScript.Echo "sshterm service is not running: " & requestError
  Else
    MsgBox "The sshterm service is not running.", 64, "Stop sshterm"
  End If
  WScript.Quit 0
End If
On Error GoTo 0

If http.Status <> 200 Then
  If isDryRun Then
    WScript.Echo "sshterm launcher-info returned HTTP " & http.Status & "."
  Else
    MsgBox "Could not verify the service on port 8787. No process was stopped.", 48, "Stop sshterm"
  End If
  WScript.Quit 1
End If

body = CStr(http.ResponseText)
Set re = New RegExp
re.Global = False
re.IgnoreCase = False
re.Pattern = """app""\s*:\s*""sshterm"""
If Not re.Test(body) Then
  If isDryRun Then
    WScript.Echo "Port 8787 is not the verified sshterm service."
  Else
    MsgBox "The service on port 8787 is not sshterm. No process was stopped.", 48, "Stop sshterm"
  End If
  WScript.Quit 1
End If

re.Pattern = """pid""\s*:\s*([0-9]+)"
Set matches = re.Execute(body)
If matches.Count <> 1 Then
  If isDryRun Then
    WScript.Echo "The verified service did not return a valid PID."
  Else
    MsgBox "The verified sshterm service did not return a valid PID. No process was stopped.", 48, "Stop sshterm"
  End If
  WScript.Quit 1
End If
processId = CLng(matches(0).SubMatches(0))

If isDryRun Then
  WScript.Echo "Verified sshterm PID: " & processId
  WScript.Quit 0
End If

If Not isConfirmed Then
  If MsgBox("Stop the sshterm background service (PID " & processId & ")?" & vbCrLf & _
      "Active SSH, VNC, and file-transfer connections will be disconnected.", 49, "Stop sshterm") <> 1 Then
    WScript.Quit 0
  End If
End If

Dim wmi, processes, item, found, result
found = False
result = -1
On Error Resume Next
Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
Set processes = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId = " & CStr(processId))
For Each item In processes
  found = True
  result = item.Terminate()
  Exit For
Next
If Err.Number <> 0 Then
  result = 2
  Err.Clear
End If
On Error GoTo 0

If Not found Then
  MsgBox "The sshterm service has already stopped.", 64, "Stop sshterm"
  WScript.Quit 0
End If

If result = 0 Then
  WScript.Sleep 500
  MsgBox "The sshterm background service has stopped." & vbCrLf & "Double-click launcher.vbs to start it again.", 64, "Stop sshterm"
  WScript.Quit 0
End If

If result = 2 And Not isElevated Then
  Dim shellApp
  Set shellApp = CreateObject("Shell.Application")
  On Error Resume Next
  shellApp.ShellExecute "wscript.exe", """" & WScript.ScriptFullName & """ /elevated /confirmed", "", "runas", 1
  If Err.Number <> 0 Then
    MsgBox "Could not request administrator access. The sshterm service was not stopped.", 16, "Stop sshterm"
  End If
  On Error GoTo 0
  WScript.Quit 0
End If

MsgBox "Could not stop the sshterm service (error " & result & "). Run stop.vbs as administrator.", 16, "Stop sshterm"
WScript.Quit 1
