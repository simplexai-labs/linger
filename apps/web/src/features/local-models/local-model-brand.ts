import {
  AiChipIcon,
  AiSparklesIcon,
  ChatGptIcon,
  ClaudeIcon,
  DeepseekIcon,
  GoogleGeminiIcon,
  GrokIcon,
  KimiAiIcon,
  MetaIcon,
  MicrosoftIcon,
  MistralIcon,
  QwenIcon,
} from "@hugeicons/core-free-icons";
import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";

import type { IconSvgElement } from "@/components/ui/icon";

import type { LocalModel } from "./local-models-queries";

export interface FamilyBrand {
  icon: IconSvgElement;
  tone: string;
}

const defaultBrand: FamilyBrand = {
  icon: AiChipIcon,
  tone: "bg-muted text-muted-foreground",
};

const featuredInklingBrand: FamilyBrand = {
  icon: AiSparklesIcon,
  tone: "bg-[var(--app-mention-surface)] text-app-info",
};

const familyBrands: Record<NonNullable<LocalModel["family"]>, FamilyBrand> = {
  claude: { icon: ClaudeIcon, tone: "bg-acorn-500/15 text-acorn-700" },
  deepseek: {
    icon: DeepseekIcon,
    tone: "bg-bluebell-500/15 text-bluebell-700",
  },
  gemma: {
    icon: GoogleGeminiIcon,
    tone: "bg-bluebell-500/15 text-bluebell-700",
  },
  glm: { icon: AiChipIcon, tone: "bg-grass-500/15 text-grass-700" },
  grok: { icon: GrokIcon, tone: "bg-fawn-500/15 text-fawn-700" },
  kimi: { icon: KimiAiIcon, tone: "bg-bubblegum-500/15 text-bubblegum-700" },
  llama: { icon: MetaIcon, tone: "bg-rain-500/15 text-rain-700" },
  mistral: { icon: MistralIcon, tone: "bg-sun-500/15 text-sun-700" },
  openai: { icon: ChatGptIcon, tone: "bg-lake-500/15 text-lake-700" },
  other: defaultBrand,
  phi: { icon: MicrosoftIcon, tone: "bg-lichen-500/15 text-lichen-700" },
  qwen: { icon: QwenIcon, tone: "bg-lavender-500/15 text-lavender-700" },
};

/** Brand icon and tinted tile classes for a model family. */
export function familyBrand(family: LocalModel["family"]): FamilyBrand {
  return family && Object.hasOwn(familyBrands, family)
    ? familyBrands[family]
    : defaultBrand;
}

/** Brand icon and tinted tile classes for a catalog or custom model entry. */
export function modelBrand(model: LocalModel): FamilyBrand {
  if (isInkling2MiniModelId(model.id)) return featuredInklingBrand;
  return familyBrand(model.family);
}
