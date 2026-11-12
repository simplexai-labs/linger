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

it("stops a release without --stop with this release's script", () => {
  const earlier = block("Function StopEarlierLinger", "FunctionEnd");
  order(
    earlier,
    'IfFileExists "$INSTDIR\\Linger.exe" 0 done',
    'IfFileExists "${STOP_MARKER}" stop',
    "${STAGE}\\resources\\app\\dist\\installer\\installer.js",
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
