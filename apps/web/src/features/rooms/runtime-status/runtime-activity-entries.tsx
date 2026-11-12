import type {
  RuntimeActivityContentBlock,
  RuntimeActivityEntry,
  RuntimeActivityPresentation,
} from "./runtime-presentation-events";

const outcomeLabels: Record<
  NonNullable<RuntimeActivityPresentation["outcome"]>,
  string
> = {
  canceled: "Canceled",
  declined: "Declined",
  failed: "Failed",
  succeeded: "Succeeded",
};

/**
 * One step's details: the tool the Runtime called, how it ended once it has,
 * and the public blocks the Computer published for it.
 */
export function RuntimeActivityEntries({
  entries,
  outcome,
  title,
  tool,
}: {
  entries: readonly RuntimeActivityEntry[];
  outcome?: RuntimeActivityPresentation["outcome"];
  title: string;
  tool: string;
}) {
  return (
    <div aria-label={`${title} details`} className="mt-1.5 space-y-1.5">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[12px] leading-4">
        <dt className="text-app-subtle">Tool</dt>
        <dd className="break-all font-mono text-app-body">{tool}</dd>
        {outcome ? (
          <>
            <dt className="text-app-subtle">Outcome</dt>
            <dd
              className={
                outcome === "failed" ? "text-app-danger" : "text-app-body"
              }
            >
              {outcomeLabels[outcome]}
            </dd>
          </>
        ) : null}
      </dl>
      {entries.map((entry, index) =>
        entry.type === "content" ? (
          <RuntimeActivityContentBlockView
            block={entry.block}
            key={JSON.stringify([
              entry.type,
              entry.block.format,
              entry.block.label,
              index,
            ])}
          />
        ) : (
          <div
            className="flex min-w-0 items-start gap-1.5 text-[12px] leading-4 text-app-muted"
            key={JSON.stringify([entry.type, entry.detail, index])}
          >
            <span
              aria-hidden="true"
              className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-app-border-strong"
            />
            <span className="min-w-0 break-words">{entry.detail}</span>
          </div>
        ),
      )}
    </div>
  );
}

function RuntimeActivityContentBlockView({
  block,
}: {
  block: RuntimeActivityContentBlock;
}) {
  return (
    <div>
      {block.label ? (
        <p className="mb-0.5 text-[10px] font-medium uppercase text-app-subtle">
          {block.label}
        </p>
      ) : null}
      {block.format === "text" ? (
        <p className="whitespace-pre-wrap break-words text-[12px] leading-4 text-app-muted">
          {block.content}
        </p>
      ) : (
        <pre className="workspace-scrollbar max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-app-border bg-app-surface-soft px-2 py-1.5 text-[12px] leading-4 text-app-body">
          <code>{block.content}</code>
        </pre>
      )}
    </div>
  );
}
