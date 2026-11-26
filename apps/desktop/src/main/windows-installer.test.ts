import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

// makensis runs only in the Windows packaging; these check how its script
// stops Linger before files are replaced or removed.
const script = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../packaging/win/installer.nsi",
  ),
  "utf8",
);
const block = (start: string, end: string) => {
  const from = script.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return script.slice(from, script.indexOf(end, from));
};
const order = (text: string, ...steps: string[]) => {
  const at = steps.map((step) => text.indexOf(step));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
};
const expandUn = (text: string, un: "" | "un.") => {
  const out: string[] = [];
  let active = true;
  let inBranch = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '!if "${UN}" == ""') {
      inBranch = true;
      active = un === "";
    } else if (trimmed === '!if "${UN}" == "un."') {
      inBranch = true;
      active = un === "un.";
    } else if (trimmed === "!else") {
      if (inBranch) active = !active;
    } else if (trimmed === "!endif") {
      inBranch = false;
      active = true;
    } else if (active) {
      out.push(line);
    }
  }
  return out.join("\n").replaceAll("${UN}", un);
};

it("stops an earlier release before an install replaces its files", () => {
  order(
    block('Section "Linger"', "SectionEnd"),
    "Call StopEarlierLinger",
    "Call CloseLinger",
    'RMDir /r "$INSTDIR\\resources"',
    'File /r "${STAGE}\\*"',
    'FileOpen $0 "${STOP_MARKER}" w',
  );
});

it("stops Linger before the uninstall removes it", () => {
  order(
    block('Section "Uninstall"', "SectionEnd"),
    'StrCpy $R0 "${INSTALLER_SCRIPT}"',
    "Call un.StopLinger",
    "Call un.CloseLinger",
    'RMDir /r "$INSTDIR"',
  );
});

it("asks only a release that knows --quit to quit, then runs the stop", () => {
  const stop = block("Function ${UN}StopLinger", "FunctionEnd");
  order(
    stop,
    'IfFileExists "${STOP_MARKER}" 0 stop',
    "--quit",
    "stop:",
    "--instance desktop --stop",
  );
});

it("waits for the app to exit only when it was asked to quit", () => {
  const stop = block("Function ${UN}StopLinger", "FunctionEnd");
  order(
    stop,
    "--instance desktop --stop",
    "stopped:",
    'IfFileExists "${STOP_MARKER}" 0 done',
    "Sleep 500",
    "done:",
  );
});

it("stops every earlier release with this release's script", () => {
  const earlier = block("Function StopEarlierLinger", "FunctionEnd");
  // An earlier release's own script may leave its services running.
  expect(earlier).not.toContain("STOP_MARKER");
  order(
    earlier,
    'IfFileExists "$INSTDIR\\Linger.exe" 0 done',
    "${STAGE}\\resources\\app\\dist\\installer\\installer.js",
    'IfFileExists "$INSTDIR\\resources\\app\\dist\\installer\\distribution.json"',
    'CopyFiles /SILENT "$INSTDIR\\resources\\app\\dist\\installer\\distribution.json" "$PLUGINSDIR"',
    'StrCpy $R0 "$PLUGINSDIR\\stop.mjs"',
    "Call StopLinger",
  );
  expect(script).toContain(
    '!define INSTALLER_SCRIPT "$INSTDIR\\resources\\app\\dist\\installer\\installer.js"',
  );
});

it("stops the services again when Retry follows a running Linger", () => {
  order(
    block("Function ${UN}CloseLinger", "FunctionEnd"),
    "IDRETRY again",
    "again:",
    "Call ${UN}StopLinger",
    "Goto retry",
  );
});

it("reads /update and /relaunch from the command line", () => {
  order(
    block("Function .onInit", "FunctionEnd"),
    "${GetParameters} $0",
    '${GetOptions} $0 "/update" $1',
    "StrCpy $Updating 1",
    '${GetOptions} $0 "/relaunch" $1',
    "StrCpy $Relaunch 1",
  );
  expect(script).toContain('!include "FileFunc.nsh"');
});

it("starts Linger after an install only when asked to relaunch", () => {
  order(
    block("Function .onInstSuccess", "FunctionEnd"),
    "StrCmp $Relaunch 1 0 done",
    "Exec '\"$INSTDIR\\Linger.exe\"'",
    "done:",
  );
});

it("shows an update only its progress page", () => {
  order(
    script,
    "!define MUI_PAGE_CUSTOMFUNCTION_SHOW ShowProgress",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating",
    "!insertmacro MUI_PAGE_FINISH",
  );
  expect(script.match(/!insertmacro MUI_PAGE_/g)).toHaveLength(2);
  order(
    block("Function SkipWhenUpdating", "FunctionEnd"),
    "$Updating",
    "Abort",
  );
  order(
    block("Function ShowProgress", "FunctionEnd"),
    "$Updating",
    "Updating Linger to ${VERSION}",
  );
  // A custom folder from /D= stays where it is.
  expect(script).toContain(
    'InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"',
  );
});

it("starts the earlier app after a failed update only if no file was replaced", () => {
  order(
    block('Section "Linger"', "SectionEnd"),
    "Call RemoveLegacyInstall",
    "StrCpy $Replacing 1",
    'RMDir /r "$INSTDIR\\resources"',
  );
  const failed = block("Function .onInstFailed", "FunctionEnd");
  order(
    failed,
    "StrCmp $Updating 1 0 done",
    "StrCmp $Replacing 1 rerun",
    'IfFileExists "$INSTDIR\\Linger.exe" 0 rerun',
    "StrCmp $Relaunch 1 0 done",
    "Exec '\"$INSTDIR\\Linger.exe\"'",
    "rerun:",
    "Run this setup again",
    "$EXEPATH",
    "done:",
  );
});

it("skips --stop during /update after --quit and jumps straight to waiting for Linger.exe", () => {
  expect(script).toContain("Var ForceFullStop");
  const stopInstall = expandUn(
    block("Function ${UN}StopLinger", "FunctionEnd"),
    "",
  );
  order(
    stopInstall,
    "StrCpy $2 0",
    'IfFileExists "$INSTDIR\\Linger.exe" 0 done',
    'IfFileExists "${STOP_MARKER}" 0 stop',
    "ExecWait '\"$INSTDIR\\Linger.exe\" --quit'",
    "StrCmp $Updating 1 0 stop",
    "StrCmp $ForceFullStop 1 stop 0",
    "StrCpy $2 1",
    "Goto wait_start",
    "stop:",
    "--instance desktop --stop",
    "stopped:",
    'IfFileExists "${STOP_MARKER}" 0 done',
    "wait_start:",
    "StrCpy $1 0",
    "wait:",
    'Delete "$INSTDIR\\Linger.exe"',
  );
});

it("falls back once to --stop if Linger.exe stays locked after /update waits", () => {
  const stopInstall = expandUn(
    block("Function ${UN}StopLinger", "FunctionEnd"),
    "",
  );
  const waitSection = stopInstall.slice(stopInstall.indexOf("wait_start:"));
  order(
    waitSection,
    "wait_start:",
    "wait:",
    'Delete "$INSTDIR\\Linger.exe"',
    "IntCmp $1 20 wait_expired",
    "Sleep 500",
    "Goto wait",
    "wait_expired:",
    "StrCmp $2 1 0 done",
    "StrCpy $2 0",
    "StrCpy $ForceFullStop 1",
    "Goto stop",
    "done:",
  );
});

it("forces a full --stop on Retry in CloseLinger for installs only", () => {
  const closeRaw = block("Function ${UN}CloseLinger", "FunctionEnd");
  order(
    closeRaw,
    "again:",
    '!if "${UN}" == ""',
    "StrCpy $ForceFullStop 1",
    "!endif",
    "Call ${UN}StopLinger",
    "Goto retry",
  );
  const closeInstall = expandUn(closeRaw, "");
  order(closeInstall, "again:", "StrCpy $ForceFullStop 1", "Call StopLinger");
  const closeUninstall = expandUn(closeRaw, "un.");
  expect(closeUninstall).not.toContain("ForceFullStop");
  order(closeUninstall, "again:", "Call un.StopLinger", "Goto retry");
});

it("always runs --stop for manual overwrite installs and uninstalls", () => {
  const stopRaw = block("Function ${UN}StopLinger", "FunctionEnd");
  // Manual overwrite installs leave $Updating unset, so StrCmp $Updating 1 0 stop
  // branches directly to stop: before setting $2 = 1 or jumping to wait_start.
  const stopInstall = expandUn(stopRaw, "");
  order(
    stopInstall,
    "StrCpy $2 0",
    "ExecWait '\"$INSTDIR\\Linger.exe\" --quit'",
    "StrCmp $Updating 1 0 stop",
    "StrCpy $2 1",
    "Goto wait_start",
    "stop:",
    "--instance desktop --stop",
  );

  // Uninstall excludes the entire /update fast path and fallback labels so
  // un.StopLinger always runs --stop with no unused labels or variables.
  const stopUninstall = expandUn(stopRaw, "un.");
  expect(stopUninstall).not.toContain("$Updating");
  expect(stopUninstall).not.toContain("$ForceFullStop");
  expect(stopUninstall).not.toContain("$2");
  expect(stopUninstall).not.toContain("wait_start");
  expect(stopUninstall).not.toContain("wait_expired");
  order(
    stopUninstall,
    'IfFileExists "${STOP_MARKER}" 0 stop',
    "ExecWait '\"$INSTDIR\\Linger.exe\" --quit'",
    "stop:",
    "--instance desktop --stop",
    "IDRETRY stop",
    "stopped:",
    'IfFileExists "${STOP_MARKER}" 0 done',
    "wait:",
    'Delete "$INSTDIR\\Linger.exe"',
    "IntCmp $1 20 done",
    "Goto wait",
    "done:",
  );
});
