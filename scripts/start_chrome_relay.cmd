@echo off
where pwsh.exe >nul 2>&1
if errorlevel 1 (
    powershell.exe -NoProfile -File "%~dp0start_chrome_relay.ps1"
) else (
    pwsh.exe -NoProfile -File "%~dp0start_chrome_relay.ps1"
)
if errorlevel 1 pause
