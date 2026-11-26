// Local-only desktop shell bridge (`window.lingerDesktop.localGateway` and
// `window.lingerDesktop.diagnostics`) used by the Models Advanced dialog.
// Absent in a browser and in older desktop builds.

export interface DesktopLocalGatewayInfo {
  readonly available: boolean;
  readonly adminUrl?: string;
  readonly username?: string;
  readonly hasPassword?: boolean;
  readonly inferenceAuthDisabled?: boolean;
}

export interface DesktopLocalGatewayApi {
  getInfo(computerId: string): Promise<DesktopLocalGatewayInfo>;
  revealPassword(computerId: string): Promise<{ readonly password: string }>;
  copyPassword(computerId: string): Promise<{
    readonly copied: boolean;
    readonly clearAfterMs: number;
  }>;
  openAdmin(computerId: string): Promise<void>;
  openFolder(computerId: string): Promise<void>;
}

export interface DesktopDiagnosticsApi {
  save(): Promise<void>;
}

export function desktopLocalGateway(): DesktopLocalGatewayApi | undefined {
  if (typeof window === "undefined") return undefined;
  const api = (
    window as { lingerDesktop?: { localGateway?: DesktopLocalGatewayApi } }
  ).lingerDesktop?.localGateway;
  return typeof api?.getInfo === "function" ? api : undefined;
}

export function desktopDiagnostics(): DesktopDiagnosticsApi | undefined {
  if (typeof window === "undefined") return undefined;
  const api = (
    window as { lingerDesktop?: { diagnostics?: DesktopDiagnosticsApi } }
  ).lingerDesktop?.diagnostics;
  return typeof api?.save === "function" ? api : undefined;
}
