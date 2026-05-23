@echo off
REM Double-click this file to launch 3D Viewer on Windows.
REM First run installs everything and builds the app (~10-15 min).
REM Subsequent runs just open the desktop window.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
pause
