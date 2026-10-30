@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0Snapper.exe" "%~dp0resources\app\packages\host\bin\snapper.mjs" %*
exit /b %errorlevel%
