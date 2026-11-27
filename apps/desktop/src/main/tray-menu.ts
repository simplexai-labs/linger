import type { Translate } from "../i18n/language.js";
import type { UpdateScope } from "../shared/api.js";
import type { StatusSummary } from "./status.js";
import { trayMessages as m } from "./tray.messages.js";
import type { AnnouncedUpdate, UpdateState } from "./updater.js";

export type TrayUpdateState = UpdateState & {
  readonly scope?: UpdateScope;
};

export type TrayAction =
  | "enroll"
  | "open"
  | "toggle-prevent-sleep"
  | "install-update"
  | "check-update"
  | "show-logs"
  | "save-diagnostics"
  | "send-diagnostics"
  | "quit";

export type TrayMenuItem =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "separator" }
  | {
      readonly kind: "action";
      readonly action: TrayAction;
      readonly label: string;
      readonly checked?: boolean;
    };

export interface TrayMenuState {
  readonly status: StatusSummary;
  readonly preventSleep: boolean;
  readonly enrolled: boolean;
  // The updater's progress; a failure says why, since it is otherwise only
  // in the log.
  readonly update?: TrayUpdateState;
  // A diagnostics server is set up, so reports can be sent from here.
  readonly canSendDiagnostics?: boolean;
}

// The tray menu. Items for features that do not exist yet
// (pause, approvals) are added with those features.
export const trayMenu = (
  state: TrayMenuState,
  t: Translate,
): TrayMenuItem[] => [
  { kind: "label", label: state.status.label },
  ...updateItems(state.update, t),
  { kind: "separator" },
  { kind: "action", action: "open", label: t(m.open) },
  // Reconnecting re-enrolls the same computer, e.g. after its credential
  // was rejected or the server moved.
  {
    kind: "action",
    action: "enroll",
    label: state.enrolled ? t(m.reconnect) : t(m.connect),
  },
  {
    kind: "action",
    action: "toggle-prevent-sleep",
    label: t(m.preventSleep),
    checked: state.preventSleep,
  },
  { kind: "separator" },
  // What to send when something goes wrong.
  { kind: "action", action: "show-logs", label: t(m.showLogs) },
  {
    kind: "action",
    action: "save-diagnostics",
    label: t(m.saveDiagnostics),
  },
  ...(state.canSendDiagnostics
    ? [
        {
          kind: "action" as const,
          action: "send-diagnostics" as const,
          label: t(m.sendDiagnostics),
        },
      ]
    : []),
  { kind: "separator" },
  // Tasks run in the app, so quitting takes the computer offline.
  { kind: "action", action: "quit", label: t(m.quit) },
];

// Long native errors would stretch the menu; the log has the full text.
const REASON_LENGTH = 80;

const updateItems = (
  update: TrayMenuState["update"],
  t: Translate,
): TrayMenuItem[] => {
  const isServiceUpdate =
    update?.scope === "web" || update?.scope === "backend";
  switch (update?.kind) {
    case "downloading":
      return [
        {
          kind: "label",
          label: isServiceUpdate
            ? t(m.serviceDownloading)
            : t(m.downloading, { version: update.version }),
        },
      ];
    case "ready":
      return [
        {
          kind: "action",
          action: "install-update",
          label: isServiceUpdate
            ? t(m.updateServices)
            : t(m.restartToUpdate, { version: update.version }),
        },
      ];
    case "waiting":
      return [
        {
          kind: "label",
          label: isServiceUpdate
            ? t(m.serviceWaiting)
            : t(m.waiting, { version: update.version }),
        },
      ];
    case "installing":
      return isServiceUpdate
        ? [{ kind: "label", label: t(m.serviceInstalling) }]
        : [];
    case "available":
      return [
        {
          kind: "action",
          action: "install-update",
          label: t(m.download, { version: update.version }),
        },
      ];
    case "failed": {
      const reason =
        update.error.length > REASON_LENGTH
          ? `${update.error.slice(0, REASON_LENGTH - 1)}…`
          : update.error;
      return [
        { kind: "label", label: t(m.updateFailed, { reason }) },
        {
          kind: "action",
          action: "check-update",
          label: t(m.tryUpdatingAgain),
        },
      ];
    }
    default:
      return [];
  }
};

// The notification for an update once it is ready or available; clicking it
// does what the tray's update item does.
export function updateNotice(
  update: AnnouncedUpdate,
  t: Translate,
): {
  title: string;
  body: string;
} {
  const values = { version: update.version };
  if (update.kind === "available")
    return { title: t(m.availableTitle), body: t(m.available, values) };
  return { title: t(m.readyTitle), body: t(m.ready, values) };
}
