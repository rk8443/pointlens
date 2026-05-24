@echo off
REM ====================================================================
REM  3D Viewer — double-click to launch.
REM  First run: auto-installs Node.js, MSVC Build Tools, Rust, WebView2,
REM             project deps, builds the app, then opens it.
REM  Subsequent runs: opens the app in ~1 second, no checks.
REM
REM  The first-time installs need admin rights (winget elevates itself
REM  via UAC prompts).  Click "Yes" when Windows asks.
REM ====================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
if errorlevel 1 pause
