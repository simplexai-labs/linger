import { AiSparklesIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import {
  INKLING_2_MINI_ANNOUNCEMENT_URL,
  INKLING_2_MINI_HF_URL,
} from "@linger/service-kit/featured-models";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";

import { localModelsMessages as m } from "./local-models.messages";

const INKLING_TITLE = "Inkling 2 Mini";

/**
 * Editorial partner frame for Thinking Machines' Inkling 2 Mini at the top of
 * the local model library. Wraps the matching `ModelRow` when present so
 * status, progress, details and actions stay in one place, and falls back to a
 * partner highlight when the Computer's catalog does not include it.
 */
export function FeaturedModelSpotlight({ children }: { children?: ReactNode }) {
  const t = useT();
  const hasEntry = Boolean(children);

  return (
    <section
      aria-label={t(m.featuredSpotlightRegion)}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-outline"
      data-featured-spotlight="inkling-2-mini"
      data-in-catalog={hasEntry ? "true" : "false"}
    >
      <div className="flex flex-col gap-2.5 bg-[var(--app-card-info-surface)] px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {!hasEntry ? (
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--app-mention-surface)] text-app-info shadow-outline"
            >
              <Icon icon={AiSparklesIcon} size={20} />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium text-app-info">
                {t(m.featuredByThinkingMachines)}
              </span>
            </div>
            {!hasEntry ? (
              <h2 className="mt-1.5 text-base font-semibold text-foreground">
                {INKLING_TITLE}
              </h2>
            ) : null}
            {!hasEntry ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t(m.featuredNotInCatalog)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs sm:pt-0.5">
          <a
            className="inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors duration-150 hover:text-app-info focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            href={INKLING_2_MINI_ANNOUNCEMENT_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{t(m.featuredReadAnnouncement)}</span>
            <Icon className="shrink-0" icon={LinkSquare02Icon} size={14} />
          </a>
          <a
            className="inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors duration-150 hover:text-app-info focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            href={INKLING_2_MINI_HF_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{t(m.featuredHuggingFace)}</span>
            <Icon className="shrink-0" icon={LinkSquare02Icon} size={14} />
          </a>
        </div>
      </div>
      {children ? <div>{children}</div> : null}
    </section>
  );
}
