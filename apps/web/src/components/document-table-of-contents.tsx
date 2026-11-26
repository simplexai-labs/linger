import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import type { RefObject } from "react";

import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { Button } from "./ui/button";
import type { DocumentHeading } from "./document-headings";

export function DocumentTableOfContents({
  contentRef,
  headings,
  id,
  onClose,
}: {
  contentRef: RefObject<HTMLElement | null>;
  headings: DocumentHeading[];
  id?: string;
  onClose: () => void;
}) {
  const t = useT();
  const baseLevel = Math.min(...headings.map((heading) => heading.level), 6);
  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 w-[min(300px,calc(100vw-24px))] border-l border-app-border bg-app-surface shadow-xl sm:relative sm:z-auto sm:shrink-0 sm:shadow-none"
      id={id}
    >
      <header className="flex h-12 items-center justify-between px-3">
        <h3 className="text-sm font-semibold">
          {t(commonMessages.tableOfContents)}
        </h3>
        <Button
          data-voice-close
          aria-label={t(commonMessages.closeTableOfContents)}
          onClick={onClose}
          size="icon"
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} />
        </Button>
      </header>
      <nav
        aria-label={t(commonMessages.documentTableOfContents)}
        className="workspace-scrollbar h-[calc(100%-48px)] overflow-y-auto p-2"
      >
        {headings.length === 0 ? (
          <p className="px-2 py-6 text-sm text-app-muted">
            {t(commonMessages.noHeadings)}
          </p>
        ) : (
          headings.map((heading) => (
            <button
              className="block h-8 w-full truncate rounded-lg px-2 text-left text-sm text-app-body transition-colors duration-300 hover:bg-muted/70 hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={heading.id}
              onClick={() =>
                contentRef.current
                  ?.querySelector(`[data-id="${CSS.escape(heading.id)}"]`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              style={{
                paddingLeft: `${8 + (heading.level - baseLevel) * 12}px`,
              }}
              type="button"
            >
              {heading.text}
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}
