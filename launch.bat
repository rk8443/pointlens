@echo off
REM ====================================================================
REM  PointLens - double-click to launch.
REM
REM  First run: auto-installs Node.js, MSVC Build Tools, Rust, WebView2,
REM             project deps, builds the app, then opens it.
REM  Later runs: launches the cached PointLens.exe in ~1 second.
REM
REM  The first-time installs need admin rights; click "Yes" when Windows
REM  shows the UAC prompt.
REM ====================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
if errorlevel 1 pause
