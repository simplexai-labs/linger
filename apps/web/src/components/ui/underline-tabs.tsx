import { useTabIndicator } from "@/components/ui/tab-indicator";
import { useTablistKeyboard } from "@/components/ui/tablist-keyboard";
import { cn } from "@/lib/cn";

/** Page-level views as a row of tabs with a sliding underline. */
export function UnderlineTabs<K extends string>({
  className,
  items,
  label,
  onChange,
  value,
}: {
  className?: string;
  items: readonly { disabled?: boolean; id: K; label: string }[];
  label: string;
  onChange: (id: K) => void;
  value: K;
}) {
  const { tabRef, indicator } = useTabIndicator(value);
  const { getTabProps, registerTab } = useTablistKeyboard({
    items,
    onChange,
    value,
  });
  return (
    <div
      aria-label={label}
      className={cn(
        "workspace-file-tabs relative flex max-w-full gap-1 overflow-x-auto",
        className,
      )}
      role="tablist"
    >
      {items.map((item) => {
        const setIndicatorRef = tabRef(item.id);
        const setKeyboardRef = registerTab(item.id);
        const keyboardProps = getTabProps(item.id, item.disabled);
        return (
          <button
            aria-selected={item.id === value}
            className="workspace-view-tab inline-flex h-9 shrink-0 items-center gap-1.5 px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            disabled={item.disabled}
            key={item.id}
            onClick={() => onChange(item.id)}
            onKeyDown={keyboardProps.onKeyDown}
            ref={(node) => {
              setIndicatorRef(node);
              setKeyboardRef(node);
            }}
            role="tab"
            tabIndex={keyboardProps.tabIndex}
            type="button"
          >
            {item.label}
          </button>
        );
      })}
      {indicator}
    </div>
  );
}
