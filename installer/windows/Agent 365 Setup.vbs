' Starts the setup wizard with no console window.
' This is the file to double-click on Windows.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & here & "\Agent 365 Setup.cmd""", 0, False
