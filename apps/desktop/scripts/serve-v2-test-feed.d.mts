export interface TestFeedServerInstance {
  readonly port: number;
  readonly feedUrl: string;
  readonly certPath: string | null;
  getActiveStep(): {
    readonly id: string;
    readonly appVersion: string;
    readonly changedModules: readonly string[];
  };
  setStep(selector: string): {
    readonly id: string;
    readonly appVersion: string;
    readonly changedModules: readonly string[];
  };
  getDownloadHistory(): Array<{
    readonly at: string;
    readonly stepId: string;
    readonly path: string;
    readonly status: number;
    readonly size: number;
  }>;
  close(): Promise<void>;
}

export declare function createTestFeedServer(options?: {
  rootDir?: string;
  initialStep?: string;
  host?: string;
  port?: number;
  useHttps?: boolean;
  certPath?: string | null;
  keyPath?: string | null;
  quiet?: boolean;
}): Promise<TestFeedServerInstance>;
