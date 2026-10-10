@echo off
cd /d "%~dp0"
py -m pip install demucs
if errorlevel 1 echo ERROR: comprueba Python y PyTorch.
pause
