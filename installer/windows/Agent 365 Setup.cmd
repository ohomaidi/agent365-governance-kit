@echo off
rem Agent 365 Governance Kit - Windows launcher.
rem Double-clicked by the customer. Finds Node, starts the local setup server
rem and opens the browser. Run via the .vbs alongside this file for no console.
setlocal
cd /d "%~dp0..\.."
set "SERVER=%CD%\installer\server.mjs"

where node >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; if ([System.Windows.MessageBox]::Show('Node.js is required and was not found.' + [char]10 + [char]10 + 'Open the download page?','Agent 365 Setup','YesNo','Warning') -eq 'Yes') { Start-Process 'https://nodejs.org/en/download' }"
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Node.js 18 or newer is required.','Agent 365 Setup','OK','Error')"
  exit /b 1
)

if not exist "%SERVER%" (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Could not find the kit. Keep this launcher inside the agent365-governance-kit folder.','Agent 365 Setup','OK','Error')"
  exit /b 1
)

node "%SERVER%"
