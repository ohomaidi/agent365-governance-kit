' ===========================================================================
'  Agent 365 Governance Kit - Windows setup launcher
'
'  Double-click this file. It finds Node.js (or downloads a private copy into
'  your user profile), starts the local setup server with no console window,
'  and opens your browser. Nothing else to install and nothing to type.
'
'  Keep it inside the Agent365-Setup folder; it locates the kit relative to
'  itself.
' ===========================================================================
Option Explicit

Const NODE_VERSION = "22.12.0"

Dim sh, fso, here, root, server, nodeExe, cmd, appHome
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appHome = sh.ExpandEnvironmentStrings("%USERPROFILE%\.agent365")

' Find the kit rather than assuming a fixed depth: this launcher ships both
' inside the repo (installer\windows\) and at the top of a distribution zip
' next to a "kit" folder.
here   = fso.GetParentFolderName(WScript.ScriptFullName)
server = FindServer(here)

If server = "" Then
  MsgBox "Could not find the setup files." & vbCrLf & vbCrLf & _
         "Keep this launcher inside the Agent365-Setup folder.", _
         vbCritical, "Agent 365 Setup"
  WScript.Quit 1
End If

' --- locate Node without a console window; download it when absent --------
nodeExe = FindNode()
If nodeExe = "" Then
  If MsgBox("Node.js is needed to run the setup page." & vbCrLf & vbCrLf & _
            "Download a private copy (about 30 MB) into your user profile?" & vbCrLf & _
            "Nothing else on this PC is changed and no admin rights are needed.", _
            vbYesNo + vbQuestion, "Agent 365 Setup") <> vbYes Then
    WScript.Quit 1
  End If
  nodeExe = DownloadNode()
  If nodeExe = "" Then
    MsgBox "The Node.js download did not complete. Check the internet connection and try again, " & _
           "or install Node.js from nodejs.org.", vbCritical, "Agent 365 Setup"
    WScript.Quit 1
  End If
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
' Returns the full path to node.exe (18 or newer), or "" if it isn't installed.
' Uses a hidden shell so no console flashes on screen.
Function FindNode()
  Dim exec, out, p, candidates, c
  FindNode = ""

  ' A copy this launcher downloaded earlier.
  c = fso.BuildPath(appHome, "node-v" & NODE_VERSION & "\node.exe")
  If fso.FileExists(c) Then FindNode = c : Exit Function

  On Error Resume Next
  Set exec = sh.Exec("%comspec% /c where node")
  If Err.Number = 0 Then
    out = exec.StdOut.ReadAll()
    If InStr(out, ":\") > 0 Then
      p = Split(Replace(out, vbCr, ""), vbLf)(0)
      If fso.FileExists(p) And NodeIsRecent(p) Then FindNode = p : Exit Function
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
    If fso.FileExists(c) And NodeIsRecent(c) Then FindNode = c : Exit Function
  Next
End Function

' True when the given node.exe is v18 or newer.
Function NodeIsRecent(p)
  Dim exec, v, major
  NodeIsRecent = False
  On Error Resume Next
  Set exec = sh.Exec("""" & p & """ -p process.versions.node")
  v = Trim(Replace(Replace(exec.StdOut.ReadAll(), vbCr, ""), vbLf, ""))
  If Err.Number = 0 And Len(v) > 0 Then
    major = CInt(Split(v, ".")(0))
    NodeIsRecent = (major >= 18)
  End If
  On Error GoTo 0
End Function

' -------------------------------------------------------------------------
' Downloads the official Node.js zip into %USERPROFILE%\.agent365 with the
' built-in Windows PowerShell 5.1 (always present), hidden. Returns the path
' to node.exe, or "" on failure.
Function DownloadNode()
  Dim arch, zipName, url, zipPath, dest, ps, rc
  DownloadNode = ""
  arch = sh.ExpandEnvironmentStrings("%PROCESSOR_ARCHITECTURE%")
  If InStr(1, arch, "ARM", vbTextCompare) > 0 Then arch = "arm64" Else arch = "x64"
  zipName = "node-v" & NODE_VERSION & "-win-" & arch & ".zip"
  url     = "https://nodejs.org/dist/v" & NODE_VERSION & "/" & zipName
  zipPath = fso.BuildPath(appHome, zipName)
  dest    = fso.BuildPath(appHome, "node-v" & NODE_VERSION)
  If Not fso.FolderExists(appHome) Then fso.CreateFolder appHome

  ps = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; " & _
       "Invoke-WebRequest -Uri '" & url & "' -OutFile '" & zipPath & "'; " & _
       "if (Test-Path '" & dest & "') { Remove-Item -Recurse -Force '" & dest & "' }; " & _
       "Expand-Archive -LiteralPath '" & zipPath & "' -DestinationPath '" & appHome & "' -Force; " & _
       "Rename-Item -LiteralPath '" & fso.BuildPath(appHome, "node-v" & NODE_VERSION & "-win-" & arch) & "' -NewName 'node-v" & NODE_VERSION & "'; " & _
       "Remove-Item -Force '" & zipPath & "'"
  rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command """ & ps & """", 0, True)
  If rc = 0 And fso.FileExists(fso.BuildPath(dest, "node.exe")) Then DownloadNode = fso.BuildPath(dest, "node.exe")
End Function
