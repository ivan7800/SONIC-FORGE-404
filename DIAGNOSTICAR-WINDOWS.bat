@echo off
setlocal
cd /d "%~dp0"
echo SONIC FORGE 404 - Diagnostico v0.22.0
where py >nul 2>nul
if not errorlevel 1 (
  py -3 diagnostico_windows.py --output "%~dp0diagnostico"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo ERROR: No se ha encontrado Python en PATH.
    echo Instala Python y vuelve a ejecutar el diagnostico.
    pause
    exit /b 1
  )
  python diagnostico_windows.py --output "%~dp0diagnostico"
)
if errorlevel 1 echo El diagnostico termino con errores.
echo.
echo Informes en la carpeta diagnostico.
pause
