@echo off
rem zk-bridge setup for Windows. Double-click this file, or run it in PowerShell / Command Prompt:
rem   setup.cmd              set everything up (asks a few questions)
rem   setup.cmd --yes        the same without questions (uses .env as it is)
rem   setup.cmd status       also: logs, start, stop, restart, test, info, update, uninstall, help
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "ZK_EXIT=%ERRORLEVEL%"
rem Keep the window open when the file was double-clicked (no arguments, started by Explorer).
if not "%~1"=="" goto done
echo %CMDCMDLINE% | find /i "%~nx0" >nul
if not errorlevel 1 pause
:done
exit /b %ZK_EXIT%
