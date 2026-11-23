import path from "node:path";

import {
  AUTOMATION_DENIED,
  denied,
  nodeProbes,
  type PermissionProbes,
  type PermissionStatus,
} from "./mac-permissions.js";

// `messagesNotSetUp`: Messages has never run for this user, so there is no
// database to read yet.
export type MessagesDiskStatus = PermissionStatus | "messagesNotSetUp";
export type SignedInStatus = "yes" | "no" | "unknown";

export interface IMessageChecks {
  readonly fullDisk: MessagesDiskStatus;
  readonly messagesAutomation: PermissionStatus;
  readonly iMessageSignedIn: SignedInStatus;
}

// Counting enabled iMessage accounts both proves Linger may control Messages
// and tells whether the person is signed in.
const COUNT_ACCOUNTS =
  'tell application "Messages" to count (every account whose service type is iMessage and enabled is true)';

// What imsg needs on this Mac: Full Disk Access to read the Messages
// database, and permission to control Messages to send. The Messages probe
// can show a system prompt and launch Messages, so it runs only after the
// person asked once; reading the database never prompts.
export class IMessagePermissions {
  readonly #home: string;
  readonly #probes: PermissionProbes;
  readonly #asked: () => boolean;
  readonly #enabled: () => boolean;
  readonly #markAsked: () => void;

  constructor(options: {
    home: string;
    asked: () => boolean;
    markAsked: () => void;
    // Whether iMessage is turned on; off, Messages is never scripted.
    enabled: () => boolean;
    probes?: PermissionProbes;
  }) {
    this.#enabled = options.enabled;
    this.#home = options.home;
    this.#asked = options.asked;
    this.#markAsked = options.markAsked;
    this.#probes = options.probes ?? nodeProbes;
  }

  async checks(): Promise<IMessageChecks> {
    const fullDisk = await this.#fullDisk();
    // The probe can launch Messages, which nobody who turned this off wants.
    if (!this.#asked() || !this.#enabled())
      return {
        fullDisk,
        messagesAutomation: "unknown",
        iMessageSignedIn: "unknown",
      };
    return { fullDisk, ...(await this.#messages()) };
  }

  // Shows the system prompt to control Messages.
  async requestAutomation(): Promise<void> {
    this.#markAsked();
    await this.#messages();
  }

  async #fullDisk(): Promise<MessagesDiskStatus> {
    try {
      await this.#probes.openFile(
        path.join(this.#home, "Library/Messages/chat.db"),
      );
      return "granted";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return "messagesNotSetUp";
      return denied(error) ? "denied" : "unknown";
    }
  }

  async #messages(): Promise<Omit<IMessageChecks, "fullDisk">> {
    try {
      const count = Number.parseInt(
        (await this.#probes.appleScript(COUNT_ACCOUNTS)).trim(),
        10,
      );
      return {
        messagesAutomation: "granted",
        iMessageSignedIn: Number.isNaN(count)
          ? "unknown"
          : count > 0
            ? "yes"
            : "no",
      };
    } catch (error) {
      return {
        messagesAutomation: String(error).includes(AUTOMATION_DENIED)
          ? "denied"
          : "unknown",
        iMessageSignedIn: "unknown",
      };
    }
  }
}
