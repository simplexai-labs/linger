export const BUNDLED_LOCALMODELS_KIT_FILENAME: "bundled-localmodels-kit.tgz";

export interface BundledLocalmodelsKitDistribution {
  platform: string;
  arch: string;
  localmodelsTool: {
    sha256: string;
    bytes: number;
  };
}

export interface StagedBundledLocalmodelsKit {
  source: string;
  destination: string;
  target: string;
  bytes: number;
  sha256: string;
}

export function stageBundledLocalmodelsKit(options: {
  kitDir: string | undefined;
  distribution: BundledLocalmodelsKitDistribution | undefined;
  installerDir: string;
}): Promise<StagedBundledLocalmodelsKit | null>;
