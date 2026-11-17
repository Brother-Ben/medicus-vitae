@echo off
rem Adds "Medicus Vitae" to the Start menu and the Desktop. Run it again after moving this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\add-shortcuts.ps1"
echo.
pause
