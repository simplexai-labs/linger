// The model makers' and publishers' logos from the app's Local models page
// (apps/web/src/features/local-models/logos, drawn by
// local-model-brand-icon.tsx), served unchanged to the setup page at
// app://setup/model-logo/<file>, so setup shows the same mark for a model.
// Each logo is its owner's trademark, shown only to name the model.
import claudeSvg from "../../../web/src/features/local-models/logos/claude.svg";
import deepseekSvg from "../../../web/src/features/local-models/logos/deepseek.svg";
import gemmaSvg from "../../../web/src/features/local-models/logos/gemma.svg";
import glmSvg from "../../../web/src/features/local-models/logos/glm.svg";
import grokSvg from "../../../web/src/features/local-models/logos/grok.svg";
import inclusionAiPng from "../../../web/src/features/local-models/logos/inclusionai.png";
import kimiSvg from "../../../web/src/features/local-models/logos/kimi.svg";
import metaSvg from "../../../web/src/features/local-models/logos/meta.svg";
import mistralSvg from "../../../web/src/features/local-models/logos/mistral.svg";
import openaiSvg from "../../../web/src/features/local-models/logos/openai.svg";
import ornithPng from "../../../web/src/features/local-models/logos/ornith.png";
import phiSvg from "../../../web/src/features/local-models/logos/phi.svg";
import qwenSvg from "../../../web/src/features/local-models/logos/qwen.svg";
import thinkingMachinesPng from "../../../web/src/features/local-models/logos/thinkingmachines.png";
import xhtokenPng from "../../../web/src/features/local-models/logos/xhtoken.png";

const svg = (bytes: Uint8Array) => ({ bytes, type: "image/svg+xml" });
const png = (bytes: Uint8Array) => ({ bytes, type: "image/png" });

export const MODEL_LOGOS: Readonly<
  Record<string, { readonly bytes: Uint8Array; readonly type: string }>
> = {
  "/model-logo/claude.svg": svg(claudeSvg),
  "/model-logo/deepseek.svg": svg(deepseekSvg),
  "/model-logo/gemma.svg": svg(gemmaSvg),
  "/model-logo/glm.svg": svg(glmSvg),
  "/model-logo/grok.svg": svg(grokSvg),
  "/model-logo/inclusionai.png": png(inclusionAiPng),
  "/model-logo/kimi.svg": svg(kimiSvg),
  "/model-logo/meta.svg": svg(metaSvg),
  "/model-logo/mistral.svg": svg(mistralSvg),
  "/model-logo/openai.svg": svg(openaiSvg),
  "/model-logo/ornith.png": png(ornithPng),
  "/model-logo/phi.svg": svg(phiSvg),
  "/model-logo/qwen.svg": svg(qwenSvg),
  "/model-logo/thinkingmachines.png": png(thinkingMachinesPng),
  "/model-logo/xhtoken.png": png(xhtokenPng),
};
