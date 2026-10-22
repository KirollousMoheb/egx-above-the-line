@echo off
rem Double-click to start "Above the Line" and open it in your browser.
cd /d "%~dp0"
python server.py %*
pause
