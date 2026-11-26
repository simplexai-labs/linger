import { Skeleton } from "@/components/ui/skeleton";

/* Loading placeholders reuse the loaded page's classes, so every section sits
   where its content will land and nothing moves when the Documents arrive. */

const skeletonKeys = ["a", "b", "c", "d", "e"] as const;

export function RecentCardsSkeleton({ label }: { label?: string }) {
  return (
    <div
      aria-busy="true"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="workspace-recent-cards"
    >
      {skeletonKeys.map((key) => (
        <div aria-hidden className="workspace-recent-card" key={key}>
          <span className="workspace-recent-link">
            <span className="workspace-recent-icon">
              <Skeleton className="size-4 rounded" />
            </span>
            <span className="workspace-recent-name">
              <Skeleton className="h-[1lh] w-3/4" />
            </span>
            <span className="workspace-recent-meta">
              <Skeleton className="h-[1lh] w-1/2" />
            </span>
            <span className="mt-2.5 text-xs">
              <Skeleton className="h-[1lh] w-12" />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function DocumentRowsSkeleton({ label }: { label?: string }) {
  return (
    <div
      aria-busy="true"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="workspace-file-list"
    >
      {skeletonKeys.slice(0, 4).map((key) => (
        <div aria-hidden className="workspace-file-row" key={key}>
          <span className="workspace-file-name">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-[1lh] w-48 max-w-full" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The Library overview while its route module loads, laid out like the page. */
export function LibraryOverviewSkeleton() {
  return (
    <main
      aria-hidden="true"
      className="workspace-content-viewport workspace-scrollbar min-w-0 flex-1 overflow-y-auto bg-app-surface [scrollbar-gutter:stable]"
    >
      <div className="workspace-file-browser">
        <header className="workspace-files-heading">
          <h2>
            <Skeleton className="h-[1lh] w-24" />
          </h2>
          <Skeleton className="ml-auto h-9 w-20" />
        </header>
        <section className="workspace-recent">
          <h3 className="workspace-recent-title">
            <Skeleton className="h-[1lh] w-14" />
          </h3>
          <RecentCardsSkeleton />
        </section>
        <div className="workspace-file-tabs flex h-9 items-center gap-6 pl-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="workspace-file-filters h-7">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-32" />
        </div>
        <DocumentRowsSkeleton />
      </div>
    </main>
  );
}
