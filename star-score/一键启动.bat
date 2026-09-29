@echo off
cd /d "%~dp0"
rem ============================================================
rem  StarScore launcher (ASCII only, works in any codepage)
rem  All Chinese messages are printed by backend\start_all.py
rem ============================================================
where py >nul 2>nul
if not errorlevel 1 goto RUN_PY
where python >nul 2>nul
if not errorlevel 1 goto RUN_PYTHON
echo [Error] Python not found. Install: https://www.python.org/downloads/
pause
exit /b 1

:RUN_PY
py backend\start_all.py
pause
exit /b 0

:RUN_PYTHON
python backend\start_all.py
pause
exit /b 0
