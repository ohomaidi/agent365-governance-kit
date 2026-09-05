' ===========================================================================
'  Agent 365 Governance Kit - Windows setup launcher
'
'  Double-click this file. It finds Node.js, starts the local setup server
'  with no console window, and opens your browser. Nothing else to install
'  and nothing to type.
'
'  Keep it inside the agent365-governance-kit folder; it locates the kit
'  relative to itself.
' ===========================================================================
Option Explicit

Dim sh, fso, here, root, server, nodeExe, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Find the kit rather than assuming a fixed depth: this launcher ships both
' inside the repo (installer\windows\) and at the top of a distribution zip
' next to a "kit" folder.
here   = fso.GetParentFolderName(WScript.ScriptFullName)
server = FindServer(here)

If server = "" Then
  MsgBox "Could not find the setup files." & vbCrLf & vbCrLf & _
         "Keep this launcher inside the agent365-governance-kit folder.", _
         vbCritical, "Agent 365 Setup"
  WScript.Quit 1
End If

' --- locate Node without a console window -------------------------------
nodeExe = FindNode()
If nodeExe = "" Then
  If MsgBox("Node.js is required and was not found." & vbCrLf & vbCrLf & _
            "Open the download page?", vbYesNo + vbExclamation, _
            "Agent 365 Setup") = vbYes Then
    sh.Run "https://nodejs.org/en/download", 1, False
  End If
  WScript.Quit 1
End If

' --- start the server hidden; it opens the browser itself ----------------
cmd = """" & nodeExe & """ """ & server & """"
sh.Run cmd, 0, False

' --- give it a moment, then confirm it came up ---------------------------
WScript.Sleep 2500
MsgBox "Setup is running in your browser." & vbCrLf & vbCrLf & _
       "If a tab didn't open, go to the address shown in the browser window." & vbCrLf & _
       "Close this message to leave setup running.", _
       vbInformation, "Agent 365 Setup"

' -------------------------------------------------------------------------
' Walks up from the launcher looking for the kit, checking both the repo
' layout and a "kit" subfolder in a distribution zip.
Function FindServer(startDir)
  Dim d, i, a, b
  FindServer = ""
  d = startDir
  For i = 0 To 5
    a = fso.BuildPath(d, "installer\server.mjs")
    If fso.FileExists(a) Then FindServer = a : Exit Function
    b = fso.BuildPath(d, "kit\installer\server.mjs")
    If fso.FileExists(b) Then FindServer = b : Exit Function
    If fso.GetParentFolderName(d) = "" Then Exit For
    d = fso.GetParentFolderName(d)
  Next
End Function

' -------------------------------------------------------------------------
' Returns the full path to node.exe, or "" if it isn't installed.
' Uses a hidden shell so no console flashes on screen.
Function FindNode()
  Dim exec, out, p, candidates, c
  FindNode = ""

  On Error Resume Next
  Set exec = sh.Exec("%comspec% /c where node")
  If Err.Number = 0 Then
    out = exec.StdOut.ReadAll()
    If InStr(out, ":\") > 0 Then
      p = Split(Replace(out, vbCr, ""), vbLf)(0)
      If fso.FileExists(p) Then FindNode = p : Exit Function
    End If
  End If
  Err.Clear
  On Error GoTo 0

  ' Common install locations, in case PATH hasn't been refreshed since install.
  candidates = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%APPDATA%\nvm\node.exe"))
  For Each c In candidates
    If fso.FileExists(c) Then FindNode = c : Exit Function
  Next
End Function
