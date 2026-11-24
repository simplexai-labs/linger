// Contract between the local setup page (app://setup) and the main process.
// The setup window walks a new install through server, sign-in, connecting
// this computer and the system permissions it needs.

import { INKLING_2_MINI_ANNOUNCEMENT_URL } from "@linger/service-kit/featured-models";
import type {
  SetupChoice,
  SetupMemory,
} from "@linger/local-installation/setup-plan";
import type { WindowsPrivateRefusal } from "@linger/local-installation/windows-private";

export interface SetupFolder {
  readonly grantId: string;
  readonly label: string;
  readonly path: string;
}

export type SetupPermission = "full-disk" | "folders" | "automation";
export type SetupPermissionStatus = "granted" | "denied" | "unknown";

// Linger installed and run on this computer instead of a team server.
export interface SetupLocalServer {
  // Whether this computer can run it; absent options are not offered.
  readonly available: boolean;
  readonly phase: "idle" | "preparing" | "installing" | "ready" | "failed";
  readonly message: string;
  // While preparing: a restart on a new version or a plain start; the page
  // words it in its own language.
  readonly preparing?: "updating" | "starting";
  // While installing: the steps shown, the current one and the overall share
  // done (0-1).
  readonly steps: readonly SetupLocalStep[];
  readonly step: SetupLocalStep;
  readonly progress: number;
  // While the current step downloads: what (label), the bytes so far and
  // in all, and the rate when the source reports one. partial: the counts
  // cover only the file downloading now, so nothing says what remains.
  readonly transfer?: SetupTransfer & { readonly label: string };
  // While installing: what a step that has run a while still waits on;
  // runtime: the installer is checking the AI runtime it set up, which on
  // Windows can take minutes with the bar standing still.
  readonly waiting?: "runtime";
  // Which installation this is; timers and the bar start over with each.
  readonly attempt: number;
  // Whether this computer can serve a local model; checked as the setup
  // window opens.
  readonly localModels: SetupLocalModelsCheck;
  // The folder the installation goes into, for showing (~ for the home
  // folder); custom once picked on the page.
  readonly location: {
    readonly path: string;
    readonly custom: boolean;
    readonly error?: string;
  };
  // Which provider keys are saved there; the page never sees them.
  readonly keys: {
    readonly composio: boolean;
  };
  // While the "signin" step shows: the AI runtime's own sign-in.
  readonly signIn?: SetupRuntimeSignIn;
  // The latest BYOK endpoint test and model listing asked for on the page.
  readonly byokCheck?: SetupByokCheck;
  readonly byokModels?: SetupByokModels;
  // Once installed: the owner account, for signing in again after logging
  // out.
  readonly account?: SetupLocalAccount;
  // Where the installation moved the earlier Simplex app's data it could
  // not upgrade (~ for the home folder).
  readonly legacyBackup?: string;
  // While failed because the installer refused a folder as not private
  // (Windows): its code and reason, for the page to say what to do.
  readonly refusal?: WindowsPrivateRefusal;
  // While failed for a reason the page words itself: checking the AI
  // runtime did not finish in time, or the installer stopped answering
  // while it ran.
  readonly failure?: "runtime_lookup_timed_out" | "runtime_lookup_unreachable";
}

export type SetupByokProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic";

// A BYOK endpoint's address and key: requests go to baseUrl + path +
// endpoint in protocol, and models are listed at baseUrl + path + /models.
// The page derives protocol from the end of that address, else from the
// runtime's own format.
export interface SetupByokEndpoint {
  readonly baseUrl: string;
  readonly path: string;
  readonly endpoint: string;
  readonly protocol: SetupByokProtocol;
  readonly apiKey?: string;
}

export interface SetupByokConfig extends SetupByokEndpoint {
  readonly modelId: string;
  readonly runtime: "claude" | "codex" | "pi";
}

// One request to the endpoint's address from this computer. message is
// localmodels' own, naming the address and HTTP status.
export type SetupByokCheck =
  | {
      readonly state: "ready";
      readonly protocol: SetupByokProtocol;
      readonly url: string;
      readonly modelId: string;
      readonly contextWindow: number;
    }
  | { readonly state: "failed"; readonly message: string };

export interface SetupByokModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
}

// The models the endpoint lists at url.
export type SetupByokModels =
  | {
      readonly state: "ready";
      readonly url: string;
      readonly models: readonly SetupByokModel[];
    }
  | { readonly state: "failed"; readonly message: string };

// The owner account in the installation's local-account.json. The password
// is present only while the person chose to show it; error says why the
// file could not be read.
export type SetupLocalAccount =
  | { readonly email: string; readonly password?: string }
  | { readonly error: string };

export type SetupLocalStep =
  | "prepare"
  | "download"
  | "services"
  | "workspace"
  | "signin"
  | "connect"
  | "agents";

// The runtime the installer set up has no sign-in on this computer. The
// person signs in on the vendor's page (url, entering deviceCode there) or
// in a terminal; Claude Code's page shows a code to paste back
// (acceptsCode). failed carries why the last attempt ended.
export interface SetupRuntimeSignIn {
  readonly runtime: "codex" | "claude" | "pi";
  readonly state:
    | "required"
    | "starting"
    | "waiting_user"
    | "failed"
    | "signed_in";
  readonly url?: string;
  readonly deviceCode?: string;
  readonly acceptsCode?: boolean;
  // Why it failed, worded by the page: unavailable, timed_out or ended.
  // message is the installer's English, for anything else.
  readonly reason?: "unavailable" | "timed_out" | "ended";
  readonly message?: string;
  // No browser opened on url; the page offers it to copy.
  readonly browserFailed?: boolean;
}

export interface SetupTransfer {
  readonly completed: number;
  readonly total?: number;
  readonly bytesPerSecond?: number;
  readonly partial?: boolean;
}

// The localmodels tool's reason code with the counts it carries. Its words
// stay in the main process log; the page has its own copy per code.
export interface SetupReason {
  readonly code: string;
  // On gpu-memory-required: the card other programs hold memory on.
  readonly gpuIndex?: number;
  // The memory free now and what the install needs free: that card's VRAM,
  // or RAM on free-memory-required.
  readonly freeBytes?: number;
  readonly requiredBytes?: number;
  // On cuda-driver-update-required / cuda-driver-version-unknown: numeric versions.
  readonly detectedCudaVersion?: string;
  readonly requiredCudaVersion?: string;
  readonly driverVersion?: string;
}

export type SetupLocalModelsCheck =
  | { readonly state: "unchecked" | "unavailable" }
  // While the check first downloads the localmodels tool: its bytes.
  | { readonly state: "checking"; readonly download?: SetupTransfer }
  | {
      readonly state: "checked";
      readonly eligible: boolean;
      // The hardware can run a local model, but a temporary blocker prevents
      // installing right now (the tool's "blocked-now", e.g. memory held by
      // other programs, gateway port in use, or harness unavailable); shown on
      // hold until a new check clears it.
      readonly blockedNow?: true;
      // While blocked now: memory free now and what the plan needs.
      readonly freeMemory?: SetupMemory;
      readonly memoryBytes: number;
      readonly diskFreeBytes: number | null;
      readonly gpu?: string;
      // The inference model to deploy, with what it needs; when eligible or
      // when a blocked-now report also included a plan.
      readonly model?: {
        readonly name: string;
        readonly downloadBytes: number | null;
        readonly diskBytes: number | null;
        readonly memoryBytes: number | null;
        readonly featuredInkling?: true;
      };
      // The localmodels tool's code for why not, or, when eligible, for
      // what could still stop the install, with the counts it carries. The
      // page words each code itself.
      readonly reasons?: readonly SetupReason[];
      // The localmodels tool's pick, which Quick Install installs:
      // "local-models" is the model above served by Pi.
      readonly recommendation?: SetupChoice;
    };

// The AI runtime the installer sets up; "recommended" lets it pick and
// "local" deploys an inference model on this computer.
export type SetupLocalRuntime =
  | "recommended"
  | "codex"
  | "claude"
  | "pi"
  | "local";

// Provider keys typed on the page: a key replaces the saved one, ""
// removes it and an absent provider keeps it.
export interface SetupProviderKeys {
  readonly composio?: string;
}

// Send Diagnostics: the zip is built (preparing), shown for consent with
// what it holds and where it goes (confirm), uploaded (sending), then the
// receiver's report id (sent) or why it failed and whether Try Again can
// help.
export type SetupDiagnosticsSend =
  | { readonly phase: "idle" | "preparing" }
  | {
      readonly phase: "confirm";
      readonly host: string;
      readonly files: readonly string[];
      readonly bytes: number;
    }
  | {
      readonly phase: "sending";
      readonly host: string;
      readonly sent: number;
      readonly total: number;
    }
  | { readonly phase: "sent"; readonly host: string; readonly reportId: string }
  | {
      readonly phase: "failed";
      readonly error: string;
      readonly retry: boolean;
    };

export interface SetupState {
  readonly platform: "darwin" | "win32" | "linux";
  readonly version: string;
  readonly serverUrl: string;
  readonly signedIn: boolean;
  readonly enrolled: boolean;
  readonly displayName: string;
  readonly preventSleep: boolean;
  readonly openAtLogin: boolean;
  readonly folders: readonly SetupFolder[];
  readonly localServer: SetupLocalServer;
  // The diagnostics zip last saved from this window, or why it failed.
  readonly diagnostics?: { readonly file?: string; readonly error?: string };
  // Send Diagnostics, present only while a diagnostics server is set up.
  readonly diagnosticsSend?: SetupDiagnosticsSend;
  // macOS privacy permissions; absent on other platforms or until checked.
  readonly permissions?: Readonly<
    Record<SetupPermission, SetupPermissionStatus>
  >;
}

// Exact HTTPS URLs that the sandboxed setup page may ask the main process to
// open in the system browser. Any other URL is rejected at the IPC boundary.
export const SETUP_EXTERNAL_URLS = [INKLING_2_MINI_ANNOUNCEMENT_URL] as const;

export type SetupExternalUrl = (typeof SETUP_EXTERNAL_URLS)[number];

export { INKLING_2_MINI_ANNOUNCEMENT_URL };

export type SetupCommand =
  | { readonly op: "server.set"; readonly serverUrl: string }
  | { readonly op: "external.open"; readonly url: SetupExternalUrl }
  | {
      readonly op: "local.start";
      readonly runtime?: SetupLocalRuntime;
      readonly byok?: SetupByokConfig;
      readonly keys?: SetupProviderKeys;
    }
  // Tests the BYOK endpoint with one request, or lists its models.
  | {
      readonly op: "local.byok.check";
      readonly byok: SetupByokConfig;
    }
  | {
      readonly op: "local.byok.models";
      readonly byok: SetupByokEndpoint;
    }
  // Checks this computer for a local model again.
  | { readonly op: "local.recheck" }
  // Picks the install folder with the system picker, or goes back to the
  // default.
  | { readonly op: "local.location.pick" }
  | { readonly op: "local.location.reset" }
  // The runtime sign-in step: start the runtime's login (or give it the
  // code its page showed; device starts Codex's device-code login), open
  // its page again, copy its link or code, check again, or install another
  // runtime instead.
  | {
      readonly op: "local.signin.start";
      readonly code?: string;
      readonly device?: true;
    }
  | { readonly op: "local.signin.open" }
  | { readonly op: "local.signin.copy"; readonly what: "url" | "code" }
  | { readonly op: "local.signin.cancel" }
  | {
      readonly op: "local.signin.switch";
      readonly runtime: "codex" | "claude" | "pi";
    }
  | {
      readonly op: "local.signin.byok";
      readonly byok: SetupByokConfig;
    }
  // The finished install's account: show or hide the password, copy it to
  // the clipboard, or show its file in the file manager.
  | { readonly op: "local.account.show"; readonly on: boolean }
  | { readonly op: "local.account.copy" }
  | { readonly op: "local.account.reveal" }
  | { readonly op: "signin.open" }
  | { readonly op: "computer.connect" }
  | { readonly op: "notifications.test" }
  | { readonly op: "prevent-sleep.set"; readonly on: boolean }
  | { readonly op: "open-at-login.set"; readonly on: boolean }
  | { readonly op: "folder.add" }
  | {
      readonly op: "permission.request";
      readonly id: Exclude<SetupPermission, "full-disk">;
    }
  | { readonly op: "permission.settings"; readonly id: SetupPermission }
  | { readonly op: "finish" }
  // Opens the log folder, or saves a redacted diagnostics zip and shows it.
  | { readonly op: "logs.open" }
  | { readonly op: "diagnostics.save" }
  // Send Diagnostics: build the zip and ask, send it, try again, cancel or
  // close, or copy the report id.
  | {
      readonly op: "diagnostics.send";
      readonly action: "start" | "confirm" | "retry" | "cancel" | "copy";
    };

export interface LingerSetupApi {
  readonly featuredAnnouncementUrl: SetupExternalUrl;
  getState(): Promise<SetupState>;
  onState(callback: (state: SetupState) => void): () => void;
  run(command: SetupCommand): Promise<SetupState>;
}

export const SETUP_IPC = {
  state: "setup.state",
  stateEvent: "setup.state.event",
  run: "setup.run",
} as const;
