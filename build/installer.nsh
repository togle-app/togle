; Add the installed command to the current user's PATH. The two registry keys also let the
; installer hooks run against a disposable HKCU subtree in packaging checks.
!ifndef TOGLE_CLI_REGISTRY_PREFIX
  !define TOGLE_CLI_REGISTRY_PREFIX ""
!endif
!if "${APP_ID}" == "io.togle.app.beta"
  !define TOGLE_CLI_PRODUCT "Togle Beta"
  !define TOGLE_TOAST_CLSID "{F35B2FFB-B9CC-42BE-A01A-85FDEE820394}"
!else
  !define TOGLE_CLI_PRODUCT "Togle"
  !define TOGLE_TOAST_CLSID "{38D38FEF-DC19-4C9F-A11D-30B1AC603BD9}"
!endif

!macro TogleCliPath action
  InitPluginsDir
  File "/oname=$PLUGINSDIR\togle-cli-path.ps1" "${BUILD_RESOURCES_DIR}\windows-cli-path.ps1"
  Push $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\togle-cli-path.ps1" ${action} "$INSTDIR\resources\bin" "${TOGLE_CLI_REGISTRY_PREFIX}Environment" "${TOGLE_CLI_REGISTRY_PREFIX}Software\${TOGLE_CLI_PRODUCT}\CLI\PathEntries"'
  Pop $0
  ${If} $0 == 0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  ${Else}
    DetailPrint "Could not update the Togle command in the user PATH ($0)."
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  !insertmacro TogleCliPath Add
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro TogleCliPath Remove
    Push $0
    ReadRegStr $0 HKCU "Software\Classes\CLSID\${TOGLE_TOAST_CLSID}\LocalServer32" ""
    ${If} $0 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DeleteRegKey HKCU "Software\Classes\CLSID\${TOGLE_TOAST_CLSID}"
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
