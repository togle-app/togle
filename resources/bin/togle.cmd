@echo off
rem The togle command of an installed Togle: starts a task in the running Togle, and lists the tasks.
rem It runs the app's program as plain Node (no window), on the command inside the app.
setlocal
set ELECTRON_RUN_AS_NODE=1
set "TOGLE_EXECUTABLE=%~dp0..\..\Togle.exe"
if /I "%~n0"=="togle-beta" set "TOGLE_EXECUTABLE=%~dp0..\..\Togle Beta.exe"
"%TOGLE_EXECUTABLE%" "%~dp0..\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
