; Per-user installer for Linger on Windows. package.py passes VERSION,
; NUMERIC_VERSION (VERSION without a prerelease suffix, for the X.X.X.X field),
; STAGE (the app folder) and OUTPUT. No administrator rights are needed. The folder
; is fixed: the uninstaller removes all of it.
Unicode true
!include "MUI2.nsh"

Name "Linger"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Linger"
; Where installs from before the rename put the app, and the app id they
; named "Open at login" after. Only the upgrade below reads them.
!define LEGACY_INSTDIR "$LOCALAPPDATA\Programs\Simplex"
!define LEGACY_APP_ID "ai.simplex.desktop.preview"
!define APP_ID "com.simplexai.linger.desktop.preview"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Linger"

VIProductVersion "${NUMERIC_VERSION}.0"
VIAddVersionKey "ProductName" "Linger"
VIAddVersionKey "FileDescription" "Linger Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Linger"
VIAddVersionKey "LegalCopyright" "Linger"

!define MUI_ICON "${STAGE}\resources\linger.ico"
!define MUI_UNICON "${STAGE}\resources\linger.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Linger.exe"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; A running Linger holds its files open. Its services, run on Linger.exe, are
; stopped again on Retry, in case it started them before it quit.
!macro CLOSE_LINGER UN
Function ${UN}CloseLinger
  retry:
  ClearErrors
  IfFileExists "$INSTDIR\Linger.exe" 0 done
  Delete "$INSTDIR\Linger.exe"
  IfErrors 0 done
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Linger is running. Quit it from its icon in the notification area, then select Retry." IDRETRY again
  Abort
  again:
  Call ${UN}StopLinger
  Goto retry
  done:
FunctionEnd
!macroend
!insertmacro CLOSE_LINGER ""
!insertmacro CLOSE_LINGER "un."

; An install from before the rename lives in another folder: close it and
; remove that folder (the app's data is elsewhere), and carry "Open at login"
; over to the new app id and folder.
Function RemoveLegacyInstall
  retry:
  ClearErrors
  IfFileExists "${LEGACY_INSTDIR}\Linger.exe" 0 removed
  Delete "${LEGACY_INSTDIR}\Linger.exe"
  IfErrors 0 removed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Linger is running. Quit it from its icon in the notification area, then select Retry." IDRETRY retry
  Abort
  removed:
  RMDir /r "${LEGACY_INSTDIR}"
  ClearErrors
  ReadRegStr $0 HKCU "${RUN_KEY}" "${LEGACY_APP_ID}"
  IfErrors done
  WriteRegStr HKCU "${RUN_KEY}" "${APP_ID}" '"$INSTDIR\Linger.exe" --background'
  DeleteRegValue HKCU "${RUN_KEY}" "${LEGACY_APP_ID}"
  done:
FunctionEnd

; Uninstalling, and installing over an earlier release, stops what Linger
; runs, so nothing keeps running or holds a file (the services run on
; Linger.exe as their Node): a running Linger quits (index.ts), then an
; installer script, run by the app's own Node, stops the installation manager
; and the services of the local installation (TeamHub, web, node-services,
; LiveKit, PostgreSQL). The script ends on its own after a time limit; setup
; goes on whatever it reports. Data stays and Linger starts the services again.
!define INSTALLER_SCRIPT "$INSTDIR\resources\app\dist\installer\installer.js"
; Written by every install since --quit and --stop: an earlier Linger.exe
; starts on --quit instead of quitting, and its script has no --stop.
!define STOP_MARKER "$INSTDIR\resources\stops-services"
; $R0 is the installer script that stops the services.
!macro STOP_LINGER UN
Function ${UN}StopLinger
  IfFileExists "$INSTDIR\Linger.exe" 0 done
  IfFileExists "${STOP_MARKER}" 0 stop
  ; Without a running Linger this exits at once.
  ExecWait '"$INSTDIR\Linger.exe" --quit'
  stop:
  IfFileExists "$R0" 0 stopped
  DetailPrint "Stopping Linger on this computer..."
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\Linger.exe" "$R0" --instance desktop --stop'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)'
  StrCmp $0 "0" stopped
  DetailPrint "Some of Linger's services may still be running."
  stopped:
  ; Only a release that was asked to quit is waited for; a running earlier
  ; one never exits on its own and CloseLinger asks at once.
  IfFileExists "${STOP_MARKER}" 0 done
  ; The app takes a moment to quit; CloseLinger asks after that.
  StrCpy $1 0
  wait:
  ClearErrors
  Delete "$INSTDIR\Linger.exe"
  IfErrors 0 done
  IntOp $1 $1 + 1
  IntCmp $1 20 done
  Sleep 500
  Goto wait
  done:
FunctionEnd
!macroend
!insertmacro STOP_LINGER ""
!insertmacro STOP_LINGER "un."

; An earlier release that cannot stop its services is stopped by this
; release's script, run by that release's Linger.exe. A running app of such a
; release is left to CloseLinger.
Function StopEarlierLinger
  IfFileExists "$INSTDIR\Linger.exe" 0 done
  StrCpy $R0 "${INSTALLER_SCRIPT}"
  IfFileExists "${STOP_MARKER}" stop
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop.mjs" "${STAGE}\resources\app\dist\installer\installer.js"
  StrCpy $R0 "$PLUGINSDIR\stop.mjs"
  stop:
  Call StopLinger
  done:
FunctionEnd

Section "Linger"
  SetOutPath "$INSTDIR"
  Call StopEarlierLinger
  Call CloseLinger
  Call RemoveLegacyInstall
  ; An update replaces the whole app folder.
  RMDir /r "$INSTDIR\resources"
  File /r "${STAGE}\*"
  FileOpen $0 "${STOP_MARKER}" w
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall Linger.exe"
  ; The app writes its notification id into this shortcut (index.ts).
  CreateShortcut "$SMPROGRAMS\Linger.lnk" "$INSTDIR\Linger.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Linger"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Linger"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Linger.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall Linger.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Settings, sign-in and logs stay in %APPDATA%\Linger, and the local
  ; installation (%USERPROFILE%\.simplexai) with its data.
  StrCpy $R0 "${INSTALLER_SCRIPT}"
  Call un.StopLinger
  Call un.CloseLinger
  Delete "$SMPROGRAMS\Linger.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; "Open at login", named after the app id (index.ts).
  DeleteRegValue HKCU "${RUN_KEY}" "${APP_ID}"
SectionEnd
