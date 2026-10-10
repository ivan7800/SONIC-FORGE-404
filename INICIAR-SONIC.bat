@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:8765"
  py -3 ai_bridge.py
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Necesitas instalar Python 3.11 o 3.12 y habilitar PATH.
    pause
    exit /b 1
  )
  start "" "http://127.0.0.1:8765"
  python ai_bridge.py
)
