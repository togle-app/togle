@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Togle release signing
set "kitNode=%~dp0tools\node.exe"
set "kitTool=%~dp0tools\release-key.mjs"
if not defined LOCALAPPDATA goto :noProfile
set "keyDir=%LOCALAPPDATA%\Togle Release Signing"
set "privateKey=%keyDir%\togle-release.key"
set "publicKey=%keyDir%\togle-release.pub"
set "exportedKey=%~dp0togle-release.pub"
if not "%~2"=="" goto :oneFile
if not "%~1"=="" goto :sign

echo Use this tool on the Windows PC that will keep the private key offline.
if exist "%privateKey%" goto :export
if exist "%publicKey%" goto :incomplete
if not exist "%keyDir%\" mkdir "%keyDir%"
if errorlevel 1 goto :failed
"%kitNode%" "%kitTool%" keygen "%keyDir%"
if errorlevel 1 goto :failed

:export
if not exist "%publicKey%" goto :incomplete
if not exist "%exportedKey%" goto :copyPublic
fc /b "%publicKey%" "%exportedKey%" >nul
if errorlevel 1 goto :conflict
goto :publicReady
:copyPublic
copy /b /-y "%publicKey%" "%exportedKey%" >nul
if errorlevel 1 goto :failed
:publicReady
echo.
echo Return the public file "%exportedKey%" to the build PC.
echo Keep the private key and its backup offline. Its folder is "%keyDir%".
goto :done

:sign
if not exist "%privateKey%" goto :noKey
if not exist "%publicKey%" goto :incomplete
if not exist "%~f1" goto :oneFile
if exist "%~f1.sig" goto :verify
"%kitNode%" "%kitTool%" sign "%privateKey%" "%~f1"
if errorlevel 1 goto :failed
:verify
"%kitNode%" "%kitTool%" verify "%publicKey%" "%~f1"
if errorlevel 1 goto :badSignature
echo.
echo Return "%~f1.sig" with the exact installer you signed.
goto :done

:incomplete
echo The key folder is incomplete. Restore the matching key pair from your offline backup.
goto :failed
:conflict
echo This extracted kit contains a different public key. Extract a fresh copy beside it.
goto :failed
:noKey
echo Double-click this launcher to create your key, or restore your existing offline key pair.
goto :failed
:noProfile
echo Windows could not locate your local user profile.
goto :failed
:oneFile
echo Drag one finished installer onto this launcher to sign it.
goto :failed
:badSignature
echo The existing signature did not verify. Check the installer and key before distributing it.
:failed
echo.
pause
exit /b 1
:done
echo.
pause
exit /b 0
