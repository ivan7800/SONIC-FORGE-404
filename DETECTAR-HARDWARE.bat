@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (py -3 detectar_hardware.py) else (python detectar_hardware.py)
pause
