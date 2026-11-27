; Per-user installer for Linger on Windows. package.py passes VERSION,
; NUMERIC_VERSION (VERSION without a prerelease suffix, for the X.X.X.X field),
; STAGE (the app folder) and OUTPUT. No administrator rights are needed. There is
; no folder page: the uninstaller removes all of the folder. An install goes where
; the last one went, else to the default folder, unless /D= names another.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "Linger"
OutFile "${OUTPUT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Linger"
InstallDir "$LOCALAPPDATA\Programs\Linger"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
; Where installs from before the rename put the app, and the app id they
; named "Open at login" after. Only the upgrade below reads them.
!define LEGACY_INSTDIR "$LOCALAPPDATA\Programs\Simplex"
!define LEGACY_APP_ID "ai.simplex.desktop.preview"
!define APP_ID "com.simplexai.linger.desktop.preview"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
RequestExecutionLevel user
; Use zlib without datablock deduplication: single-threaded LZMA spends
; minutes re-compressing bundled archives, and datablock optimization scans
; quadratically across the thousands of files in computer-tools.
SetCompressor zlib
SetDatablockOptimize off

VIProductVersion "${NUMERIC_VERSION}.0"
VIAddVersionKey "ProductName" "Linger"
VIAddVersionKey "FileDescription" "Linger Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Linger"
VIAddVersionKey "LegalCopyright" "Linger"

!define MUI_ICON "${STAGE}\resources\linger.ico"
!define MUI_UNICON "${STAGE}\resources\linger.ico"
; The app's self-update runs this setup with /update /relaunch after it quit
; (updater.ts): the progress page alone, which closes when done (the finish
; page's MUI sets SetAutoClose true), then Linger starts. Unlike /S, the
; questions below stay visible. /S still installs without any window.
Var Updating
Var Relaunch
; Set when an update's fast-path wait expires or the user clicks Retry: forces
; the full --stop even during /update.
Var ForceFullStop
; Set once the install starts replacing files: the earlier app can no longer
; start after a failure.
Var Replacing
!define MUI_FINISHPAGE_RUN "$INSTDIR\Linger.exe"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ShowProgress
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/update" $1
  IfErrors +2
  StrCpy $Updating 1
  ClearErrors
  ${GetOptions} $0 "/relaunch" $1
  IfErrors +2
  StrCpy $Relaunch 1
FunctionEnd

Function ShowProgress
  StrCmp $Updating 1 0 done
  !insertmacro MUI_HEADER_TEXT "Updating Linger" "Updating Linger to ${VERSION}..."
  done:
FunctionEnd

Function SkipWhenUpdating
  StrCmp $Updating 1 0 +2
  Abort
FunctionEnd

; A running Linger holds its files open. On Retry, install forces a full
; --stop (even during /update) before retrying in case services or an earlier
; release still hold Linger.exe; uninstall always runs the full --stop.
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
!if "${UN}" == ""
  StrCpy $ForceFullStop 1
!endif
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

; Uninstalling, and manual installs over an earlier release, stop what Linger
; runs so nothing keeps running or holds a file: a running Linger quits
; (index.ts), then an installer script, run by the app's own Node, stops the
; installation manager and the services of the local installation (TeamHub,
; web, node-services, LiveKit, PostgreSQL). Self-updates (/update) skip that
; initial --stop after --quit so warm external-Node services stay up for the
; new version's in-place resume; if Linger.exe is still locked after waiting
; (such as upgrading from an earlier release whose services ran on Linger.exe),
; StopLinger falls back once to --stop before CloseLinger prompts, and Retry
; always forces --stop. The script ends on its own after a time limit. An
; install goes on whatever it reports, and Linger starts the services again.
; An uninstall that cannot stop them asks to retry; cancelled (or silent), it
; fails with exit code 1 and removes nothing, so it can be run again. Data
; stays either way.
!define INSTALLER_SCRIPT "$INSTDIR\resources\app\dist\installer\installer.js"
; Written by every install since --quit and --stop: an earlier Linger.exe
; starts on --quit instead of quitting, and its script has no --stop.
!define STOP_MARKER "$INSTDIR\resources\stops-services"
; $R0 is the installer script that stops the services.
!macro STOP_LINGER UN
Function ${UN}StopLinger
!if "${UN}" == ""
  StrCpy $2 0
!endif
  IfFileExists "$INSTDIR\Linger.exe" 0 done
  IfFileExists "${STOP_MARKER}" 0 stop
  ; Without a running Linger this exits at once.
  ExecWait '"$INSTDIR\Linger.exe" --quit'
!if "${UN}" == ""
  StrCmp $Updating 1 0 stop
  StrCmp $ForceFullStop 1 stop 0
  StrCpy $2 1
  DetailPrint "Waiting for Linger to close before updating..."
  Goto wait_start
!endif
  stop:
  IfFileExists "$R0" 0 stopped
  DetailPrint "Stopping Linger on this computer..."
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\Linger.exe" "$R0" --instance desktop --stop'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)'
  StrCmp $0 "0" stopped
  DetailPrint "Some of Linger's services may still be running."
!if "${UN}" == "un."
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Linger couldn't stop all of its services. Close Linger and try again." /SD IDCANCEL IDRETRY stop
  SetErrorLevel 1
  Abort
!endif
  stopped:
  ; Only a release that was asked to quit is waited for; a running earlier
  ; one never exits on its own and CloseLinger asks at once.
  IfFileExists "${STOP_MARKER}" 0 done
!if "${UN}" == ""
  wait_start:
!endif
  ; The app takes a moment to quit; CloseLinger asks after that.
  StrCpy $1 0
  wait:
  ClearErrors
  Delete "$INSTDIR\Linger.exe"
  IfErrors 0 done
  IntOp $1 $1 + 1
!if "${UN}" == ""
  IntCmp $1 20 wait_expired
!else
  IntCmp $1 20 done
!endif
  Sleep 500
  Goto wait
!if "${UN}" == ""
  wait_expired:
  ; Self-update skipped the full stop so warm services stay up; if
  ; Linger.exe is still locked (for example upgrading from an earlier
  ; release whose services ran on Linger.exe), fall back once to the full
  ; stop before CloseLinger prompts the user.
  StrCmp $2 1 0 done
  StrCpy $2 0
  StrCpy $ForceFullStop 1
  DetailPrint "Linger is still in use; stopping local services before updating..."
  Goto stop
!endif
  done:
FunctionEnd
!macroend
!insertmacro STOP_LINGER ""
!insertmacro STOP_LINGER "un."

; An earlier release's services are stopped by this release's script, run
; by that release's Linger.exe: an earlier script may not stop them (one
; before --stop has none; 0.1.2's left TeamHub, web and node-services
; running). A running app of a release without the marker is left to
; CloseLinger.
Function StopEarlierLinger
  IfFileExists "$INSTDIR\Linger.exe" 0 done
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop.mjs" "${STAGE}\resources\app\dist\installer\installer.js"
  ; The temporary script reads distribution.json beside itself. Use the
  ; installed release's pins, since those are the tools it started.
  IfFileExists "$INSTDIR\resources\app\dist\installer\distribution.json" 0 +2
  CopyFiles /SILENT "$INSTDIR\resources\app\dist\installer\distribution.json" "$PLUGINSDIR"
  StrCpy $R0 "$PLUGINSDIR\stop.mjs"
  Call StopLinger
  done:
FunctionEnd

Section "Linger"
  SetOutPath "$INSTDIR"
  Call StopEarlierLinger
  Call CloseLinger
  Call RemoveLegacyInstall
  ; An update replaces the whole app folder.
  StrCpy $Replacing 1
  RMDir /r "$INSTDIR\resources"
  ; Exclude pre-compressed archives from zlib compression so packaging and
  ; install avoid wasting CPU re-compressing and re-inflating them.
  File /r /x *.tar.gz /x *.tar.zst /x *.tgz /x *.zip "${STAGE}\*"
  SetOutPath "$INSTDIR"
  SetCompress off
  File /nonfatal /r "${STAGE}\*.tar.gz"
  File /nonfatal /r "${STAGE}\*.tar.zst"
  File /nonfatal /r "${STAGE}\*.tgz"
  File /nonfatal /r "${STAGE}\*.zip"
  SetCompress auto
  SetOutPath "$INSTDIR"
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

; Neither a silent install nor an update shows the finish page to start
; Linger from.
Function .onInstSuccess
  StrCmp $Relaunch 1 0 done
  Exec '"$INSTDIR\Linger.exe"'
  done:
FunctionEnd

; Runs after Cancel on a question, or Abort on a file that could not be
; written, once the person closes the window. An update that stopped before
; replacing files starts the earlier app again, which offers the update again;
; otherwise only this setup can bring Linger back.
Function .onInstFailed
  StrCmp $Updating 1 0 done
  StrCmp $Replacing 1 rerun
  IfFileExists "$INSTDIR\Linger.exe" 0 rerun
  MessageBox MB_OK|MB_ICONEXCLAMATION "Linger was not updated. It will start again and offer the update again." /SD IDOK
  StrCmp $Relaunch 1 0 done
  Exec '"$INSTDIR\Linger.exe"'
  Goto done
  rerun:
  MessageBox MB_OK|MB_ICONEXCLAMATION "Linger was not updated and cannot start until it is. Run this setup again to finish the update:$\r$\n$EXEPATH" /SD IDOK
  done:
FunctionEnd

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
