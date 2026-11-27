import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";

import { cn } from "@/lib/cn";

import type { LocalModel } from "./local-models-queries";
import claudeLogo from "./logos/claude.svg";
import deepseekLogo from "./logos/deepseek.svg";
import gemmaLogo from "./logos/gemma.svg";
import glmLogo from "./logos/glm.svg";
import grokLogo from "./logos/grok.svg";
import inclusionAiLogo from "./logos/inclusionai.png";
import kimiLogo from "./logos/kimi.svg";
import metaLogo from "./logos/meta.svg";
import mistralLogo from "./logos/mistral.svg";
import openaiLogo from "./logos/openai.svg";
import ornithLogo from "./logos/ornith.png";
import phiLogo from "./logos/phi.svg";
import qwenLogo from "./logos/qwen.svg";
import thinkingMachinesLogo from "./logos/thinkingmachines.png";
import xhtokenLogo from "./logos/xhtoken.png";

interface ModelBrandAsset {
  /** Whether the logo is a full-bleed square badge/avatar vs a transparent mark. */
  readonly fullBleed?: boolean;
  readonly id: string;
  /** Pure black vector marks that should invert on dark surfaces. */
  readonly invertInDark?: boolean;
  readonly src: string;
}

const familyBrands: Partial<
  Record<NonNullable<LocalModel["family"]>, ModelBrandAsset>
> = {
  claude: { id: "claude", src: claudeLogo },
  deepseek: { id: "deepseek", src: deepseekLogo },
  gemma: { id: "gemma", src: gemmaLogo },
  glm: { id: "glm", src: glmLogo },
  grok: { id: "grok", invertInDark: true, src: grokLogo },
  kimi: { fullBleed: true, id: "kimi", src: kimiLogo },
  llama: { id: "meta", src: metaLogo },
  mistral: { id: "mistral", src: mistralLogo },
  openai: { id: "openai", invertInDark: true, src: openaiLogo },
  phi: { id: "phi", src: phiLogo },
  qwen: { id: "qwen", src: qwenLogo },
};

const thinkingMachinesBrand: ModelBrandAsset = {
  fullBleed: true,
  id: "thinkingmachines",
  src: thinkingMachinesLogo,
};

const sourceOrgBrands: Readonly<Record<string, ModelBrandAsset>> = {
  inclusionai: { fullBleed: true, id: "inclusionai", src: inclusionAiLogo },
  "ornith-ai": { fullBleed: true, id: "ornith", src: ornithLogo },
  thinkingmachines: thinkingMachinesBrand,
  xhtoken: { id: "xhtoken", src: xhtokenLogo },
};

const modelIdPrefixBrands: readonly (readonly [string, ModelBrandAsset])[] = [
  ["ornith-", sourceOrgBrands["ornith-ai"]!],
  ["spark-", sourceOrgBrands.xhtoken!],
  ["ling-", sourceOrgBrands.inclusionai!],
];

function huggingFaceOrgSlug(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const parsed = new URL(sourceUrl);
    const host = parsed.hostname.toLowerCase();
    if (
      host !== "huggingface.co" &&
      host !== "www.huggingface.co" &&
      host !== "hf.co"
    ) {
      return undefined;
    }
    const [org] = parsed.pathname.split("/").filter(Boolean);
    return org?.toLowerCase();
  } catch {
    return undefined;
  }
}

function resolveModelBrand(model: LocalModel): ModelBrandAsset | undefined {
  if (isInkling2MiniModelId(model.id)) return thinkingMachinesBrand;
  if (model.family && model.family !== "other") {
    return familyBrands[model.family];
  }
  const org = huggingFaceOrgSlug(model.source_url);
  if (org && Object.hasOwn(sourceOrgBrands, org)) {
    return sourceOrgBrands[org];
  }
  const lowerId = model.id.toLowerCase();
  for (const [prefix, brand] of modelIdPrefixBrands) {
    if (lowerId.startsWith(prefix)) return brand;
  }
  return undefined;
}

function DefaultModelMark() {
  return (
    <svg
      aria-hidden
      className="size-4 shrink-0"
      fill="none"
      viewBox="0 0 20 20"
    >
      <path
        d="M10 3.25 16.5 7 10 10.75 3.5 7 10 3.25Z"
        fill="currentColor"
        fillOpacity={0.09}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.45}
      />
      <path
        d="M3.5 10.5 10 14.25l6.5-3.75M3.5 13.75 10 17.5l6.5-3.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity={0.75}
        strokeWidth={1.35}
      />
    </svg>
  );
}

/** Official brand or publisher icon for a local model row. */
export function ModelBrandIcon({
  model,
  muted = false,
}: {
  model: LocalModel;
  muted?: boolean;
}) {
  const brand = resolveModelBrand(model);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1 ring-inset ring-border/45",
        brand?.fullBleed ? "bg-card" : "bg-muted/35 text-foreground/65",
      )}
      data-brand={brand?.id ?? "default"}
      data-family={model.family ?? "other"}
    >
      {brand ? (
        <img
          alt=""
          aria-hidden
          className={cn(
            "shrink-0 transition-[filter,opacity] duration-150",
            brand.fullBleed
              ? "size-full object-cover"
              : "size-[19px] object-contain",
            brand.invertInDark && "dark:invert",
            muted && "opacity-75 grayscale",
          )}
          src={brand.src}
        />
      ) : (
        <DefaultModelMark />
      )}
    </span>
  );
}

/** Real Thinking Machines mark for the Inkling 2 Mini spotlight fallback. */
export function ThinkingMachinesMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-card ring-1 ring-inset ring-border/45",
        className,
      )}
      data-brand="thinkingmachines"
    >
      <img
        alt=""
        aria-hidden
        className="size-full shrink-0 object-cover"
        src={thinkingMachinesLogo}
      />
    </span>
  );
}
