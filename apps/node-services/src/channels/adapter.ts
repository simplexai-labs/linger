import type { components as NodeComponents } from "@linger/wire-contracts/node-services-internal/types";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";

export type ChannelProvider = components["schemas"]["IMChannelProvider"];
export type ChannelRuntimeStatus =
  components["schemas"]["IMChannelRuntimeStatus"];
export type ChannelPairingStatus =
  NodeComponents["schemas"]["IMChannelPairingStatus"];

export interface ChannelCapabilities {
  readonly maxTextChars: number;
  readonly supportsClickableLinks: boolean;
  readonly supportsTyping: boolean;
  readonly supportsMarkdown: boolean;
}

export interface InboundChannelAttachment {
  readonly filename: string;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
}

export interface InboundChannelMessage {
  readonly externalId: string;
  readonly senderExternalId: string;
  readonly text: string;
  readonly attachments?: readonly InboundChannelAttachment[];
  readonly receivedAtMs: number;
  readonly adapterStatePatch?: Record<string, unknown>;
}

export interface OutboundChannelMessage {
  readonly text: string;
  readonly roomSeq: number;
}

export interface OutboundChannelMedia {
  readonly filename: string;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
  readonly roomSeq: number;
}

export type SendOutcome =
  | {
      readonly ok: true;
      readonly adapterStatePatch?: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly errorCode: string;
      readonly runtimeStatus?: ChannelRuntimeStatus;
      readonly cooldownSec?: number;
    };

export interface AdapterStatusUpdate {
  readonly runtimeStatus: ChannelRuntimeStatus;
  readonly errorCode?: string | null;
  readonly cooldownUntil?: string | null;
  readonly adapterStatePatch?: Record<string, unknown>;
}

export interface AdapterRunContext {
  readonly signal: AbortSignal;
  onInbound(message: InboundChannelMessage): Promise<void>;
  onStatus(update: AdapterStatusUpdate): Promise<void>;
}

/** Uniform transport contract implemented by every network IM provider adapter. */
export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  readonly capabilities: ChannelCapabilities;
  start(ctx: AdapterRunContext): Promise<void>;
  sendText(message: OutboundChannelMessage): Promise<SendOutcome>;
  sendMedia?(media: OutboundChannelMedia): Promise<SendOutcome>;
  setTyping?(active: boolean): Promise<void>;
}

export interface PairingPollResult {
  readonly pairingId: string;
  readonly provider: ChannelProvider;
  readonly status: ChannelPairingStatus;
  readonly qrCodeUrl?: string;
  readonly errorCode?: string;
  readonly credentials?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
}

/** Interactive pairing handler for providers that use QR or device login. */
export interface ChannelPairingProvider {
  readonly provider: ChannelProvider;
  startPairing(localTokens?: readonly string[]): Promise<PairingPollResult>;
  pollPairing(pairingId: string): Promise<PairingPollResult | undefined>;
  submitVerifyCode?(
    pairingId: string,
    verifyCode: string,
  ): Promise<PairingPollResult | undefined>;
}
