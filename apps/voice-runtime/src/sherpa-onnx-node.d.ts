declare module "sherpa-onnx-node" {
  export class OnlineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }

  export interface OnlineRecognizerResult {
    text?: string;
  }

  export class OnlineRecognizer {
    constructor(config: unknown);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    getResult(stream: OnlineStream): OnlineRecognizerResult;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
  }
}
