declare module "*pi-mcp.mjs" {
  import type {
    BuildSystemPromptOptions,
    CompactionResult,
    ExtensionFactory,
    LoadedMcpConfig,
  } from "@earendil-works/pi-coding-agent";

  export interface ManagedPiModel {
    readonly provider?: string;
    readonly id?: string;
    readonly api?: string;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
    readonly reasoning?: boolean;
    readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
    readonly compat?: { readonly thinkingFormat?: string };
  }

  export interface CompactionPolicy {
    readonly thinkingLevel: string;
    readonly reserveTokens: number;
    readonly keepRecentTokens: number;
    readonly maxSummaryTokens: number;
    readonly effectiveContextWindow: number;
  }

  export const PERMISSION_REVIEW: string;
  export function reviewedTool(toolName: string): boolean;
  export function reviewToolCall(
    event: {
      readonly toolName: string;
      readonly input?: Record<string, unknown>;
    },
    ui: {
      readonly input: (
        title: string,
        placeholder: string,
        options?: { readonly signal?: AbortSignal },
      ) => Promise<string | undefined>;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined>;
  export function refuseRewrittenShellText(
    event: {
      readonly toolName: string;
      readonly input?: Record<string, unknown>;
    },
    hook?: string,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined>;

  export function parseConfiguredContextWindow(raw: unknown): number;
  export function isLocalModel(model: ManagedPiModel | undefined): boolean;
  export function resolveEffectiveContextWindow(
    model: ManagedPiModel | undefined,
    configuredContextWindow?: number | string,
  ): number;
  export function isConstrainedContext(
    model: ManagedPiModel | undefined,
    configuredContextWindow?: number | string,
  ): boolean;
  export function compactSkillDescription(
    description: string,
    maxChars: number,
  ): string;
  export function applyManagedPromptOptions<
    T extends Partial<BuildSystemPromptOptions>,
  >(
    options: T,
    model?: ManagedPiModel,
    configuredContextWindow?: number | string,
  ): T;
  export function selectCompactionThinkingLevel(
    model: ManagedPiModel | undefined,
    currentThinkingLevel?: string,
  ): string;
  export function resolveCompactionPolicy(
    model: ManagedPiModel | undefined,
    currentThinkingLevel?: string,
    configuredContextWindow?: number | string,
  ): CompactionPolicy | null;
  export function handleSessionBeforeCompact(
    event: unknown,
    ctx: unknown,
    deps?: {
      readonly configuredContextWindow?: number | string;
      readonly compactFn?: (...args: unknown[]) => Promise<CompactionResult>;
      readonly prepareCompactionFn?: (
        entries: unknown[],
        settings: {
          readonly enabled: boolean;
          readonly reserveTokens: number;
          readonly keepRecentTokens: number;
        },
      ) => unknown;
      readonly streamSimple?: (...args: unknown[]) => unknown;
      readonly retrySettings?: {
        readonly enabled?: boolean;
        readonly maxRetries?: number;
        readonly baseDelayMs?: number;
        readonly maxAgentDelayMs?: number;
      };
    },
  ): Promise<{ compaction: CompactionResult } | undefined>;
  export function loadManagedMcpConfig(configPath: string): LoadedMcpConfig;
  export const MCP_SYNC_COMMAND: string;
  export const MCP_SYNC_DIALOG: string;
  export function mountManagedMcp(
    pi: unknown,
    configPath: string,
    mountExtension?: (pi: unknown) => Promise<void>,
  ): Promise<void>;
  export function createManagedPiExtension(options?: {
    readonly getConfigPath?: () => string | undefined;
    readonly getContextWindow?: () => string | number | undefined;
  }): ExtensionFactory;

  const extension: ExtensionFactory;
  export default extension;
}
