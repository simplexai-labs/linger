import {
  ArrowDown01Icon,
  Cancel01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  DropdownOption,
  DropdownOptions,
} from "@/components/ui/dropdown-options";
import { Icon } from "@/components/ui/icon";
import { useAnchoredSelectPopup } from "@/components/ui/select-popup";
import { StatusDot } from "@/features/local-computer/computer-row";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { localModelsMessages as m } from "./local-models.messages";

/** Show search and status filtering once the Computer list exceeds ten items. */
export const COMPUTER_PICKER_SEARCH_THRESHOLD = 10;

const VIEWPORT_GUTTER_PX = 8;
const SEARCHABLE_POPUP_MAX_WIDTH_PX = 320;
const COMPACT_POPUP_MIN_WIDTH_PX = 200;

export interface ComputerPickerOption {
  readonly computerId: string;
  readonly displayName: string;
  readonly online: boolean;
}

export type ComputerStatusFilter = "all" | "online" | "offline";

/** Places online Computers before offline ones while keeping each group's order. */
export function orderComputerPickerOptions(
  options: readonly ComputerPickerOption[],
): ComputerPickerOption[] {
  const online: ComputerPickerOption[] = [];
  const offline: ComputerPickerOption[] = [];
  for (const option of options) {
    if (option.online) online.push(option);
    else offline.push(option);
  }
  return [...online, ...offline];
}

/** Filters ordered Computer options by connection status and search query. */
export function filterComputerPickerOptions(
  options: readonly ComputerPickerOption[],
  filter: {
    readonly query: string;
    readonly status: ComputerStatusFilter;
  },
): ComputerPickerOption[] {
  const normalizedQuery = filter.query.trim().toLocaleLowerCase();
  return options.filter((option) => {
    if (filter.status === "online" && !option.online) return false;
    if (filter.status === "offline" && option.online) return false;
    if (!normalizedQuery) return true;
    return (
      option.displayName.toLocaleLowerCase().includes(normalizedQuery) ||
      option.computerId.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
}

function popupWidthFor({
  searchable,
  triggerWidth,
  viewportWidth,
}: {
  readonly searchable: boolean;
  readonly triggerWidth: number;
  readonly viewportWidth: number;
}): number {
  const maxWidth = Math.max(160, viewportWidth - VIEWPORT_GUTTER_PX * 2);
  return searchable
    ? Math.min(SEARCHABLE_POPUP_MAX_WIDTH_PX, maxWidth)
    : Math.min(Math.max(triggerWidth, COMPACT_POPUP_MIN_WIDTH_PX), maxWidth);
}

/**
 * Compact header switcher for Settings › Models. Displays live connection dots
 * and online-first ordering for every fleet size, and progressively reveals
 * search plus All / Online / Offline filters once more than 10 Computers exist.
 */
export function ComputerPicker({
  onSelect,
  options,
  value,
}: {
  readonly onSelect: (computerId: string) => void;
  readonly options: readonly ComputerPickerOption[];
  readonly value: string;
}) {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);

  const orderedOptions = useMemo(
    () => orderComputerPickerOptions(options),
    [options],
  );
  const selected = orderedOptions.find((option) => option.computerId === value);
  const searchable = orderedOptions.length > COMPUTER_PICKER_SEARCH_THRESHOLD;
  const triggerLabel = selected
    ? selected.online
      ? selected.displayName
      : t(m.computerOffline, { name: selected.displayName })
    : "";

  function close(focusTrigger = false) {
    setOpen(false);
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t(m.computerPicker)}
        className="select-pill min-w-0 max-w-56 text-left"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
        value={value}
      >
        {selected ? (
          <StatusDot tone={selected.online ? "success" : "neutral"} />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <Icon
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          icon={ArrowDown01Icon}
          size={14}
        />
      </button>
      {open ? (
        <ComputerPickerPopup
          listboxId={listboxId}
          onChoose={(computerId) => {
            onSelect(computerId);
            close(true);
          }}
          onClose={close}
          options={orderedOptions}
          searchable={searchable}
          triggerRef={triggerRef}
          value={value}
        />
      ) : null}
    </>
  );
}

function ComputerPickerPopup({
  listboxId,
  onChoose,
  onClose,
  options,
  searchable,
  triggerRef,
  value,
}: {
  readonly listboxId: string;
  readonly onChoose: (computerId: string) => void;
  readonly onClose: (focusTrigger?: boolean) => void;
  readonly options: readonly ComputerPickerOption[];
  readonly searchable: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly value: string;
}) {
  const t = useT();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionNodesRef = useRef(new Map<string, HTMLButtonElement>());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ComputerStatusFilter>("all");
  const [highlightedId, setHighlightedId] = useState<string | null>(value);

  const onlineCount = useMemo(
    () => options.filter((option) => option.online).length,
    [options],
  );
  const offlineCount = options.length - onlineCount;
  const filtered = useMemo(
    () =>
      searchable
        ? filterComputerPickerOptions(options, {
            query,
            status: statusFilter,
          })
        : [...options],
    [options, query, searchable, statusFilter],
  );

  const activeId = useMemo(() => {
    if (
      highlightedId &&
      filtered.some((item) => item.computerId === highlightedId)
    ) {
      return highlightedId;
    }
    if (filtered.some((item) => item.computerId === value)) return value;
    return filtered[0]?.computerId ?? null;
  }, [filtered, highlightedId, value]);

  const showGroups =
    searchable &&
    statusFilter === "all" &&
    filtered.some((item) => item.online) &&
    filtered.some((item) => !item.online);
  const onlineFiltered = showGroups
    ? filtered.filter((item) => item.online)
    : filtered;
  const offlineFiltered = showGroups
    ? filtered.filter((item) => !item.online)
    : [];

  const { popupRef, portalRoot, position, style, supportsPopover } =
    useAnchoredSelectPopup({
      align: "auto",
      fixedWidth: searchable,
      layoutKey: filtered.length,
      onClose,
      resolveWidth: ({ triggerWidth, viewportWidth }) =>
        popupWidthFor({ searchable, triggerWidth, viewportWidth }),
      triggerRef,
    });

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      if (searchable) {
        searchInputRef.current?.focus({ preventScroll: true });
      } else {
        const targetId = options.some((item) => item.computerId === value)
          ? value
          : options[0]?.computerId;
        if (targetId) {
          optionNodesRef.current.get(targetId)?.focus({ preventScroll: true });
        }
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [options, searchable, value]);

  function moveActive(direction: 1 | -1) {
    if (filtered.length === 0) return;
    const currentIndex = filtered.findIndex(
      (item) => item.computerId === activeId,
    );
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : filtered.length - 1
        : (currentIndex + direction + filtered.length) % filtered.length;
    const nextItem = filtered[nextIndex];
    if (!nextItem) return;
    setHighlightedId(nextItem.computerId);
    const node = optionNodesRef.current.get(nextItem.computerId);
    if (!searchable) node?.focus();
    node?.scrollIntoView?.({ block: "nearest" });
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab" && !searchable) {
      onClose();
      return;
    }
    if (!searchable && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter" && activeId) {
      event.preventDefault();
      onChoose(activeId);
    }
  }

  function resetFilters() {
    setQuery("");
    setStatusFilter("all");
    searchInputRef.current?.focus();
  }

  function optionDomId(computerId: string) {
    return `${listboxId}-opt-${computerId}`;
  }

  function renderOption(option: ComputerPickerOption) {
    const isSelected = option.computerId === value;
    const isActive = searchable && option.computerId === activeId;
    const accessibleName = option.online
      ? option.displayName
      : t(m.computerOffline, { name: option.displayName });

    return (
      <DropdownOption
        aria-label={accessibleName}
        aria-selected={isSelected}
        className={cn("gap-2", isActive && "bg-accent text-accent-foreground")}
        id={optionDomId(option.computerId)}
        key={option.computerId}
        labelClassName={cn("flex-1", !option.online && "text-muted-foreground")}
        leading={<StatusDot tone={option.online ? "success" : "neutral"} />}
        onClick={() => onChoose(option.computerId)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onChoose(option.computerId);
          }
        }}
        onMouseEnter={() => {
          if (searchable) setHighlightedId(option.computerId);
        }}
        ref={(node) => {
          if (node) optionNodesRef.current.set(option.computerId, node);
          else optionNodesRef.current.delete(option.computerId);
        }}
        role="option"
        tabIndex={-1}
        trailing={
          !option.online || isSelected ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {!option.online ? (
                <span className="text-xs text-muted-foreground">
                  {t(m.computerStatusOffline)}
                </span>
              ) : null}
              {isSelected ? (
                <Icon className="text-foreground" icon={Tick02Icon} size={14} />
              ) : null}
            </span>
          ) : null
        }
      >
        {option.displayName}
      </DropdownOption>
    );
  }

  const filterTabs: readonly {
    readonly count: number;
    readonly dot?: "neutral" | "success";
    readonly key: ComputerStatusFilter;
    readonly label: string;
  }[] = [
    { count: options.length, key: "all", label: t(m.computerFilterAll) },
    {
      count: onlineCount,
      dot: "success",
      key: "online",
      label: t(m.computerFilterOnline),
    },
    {
      count: offlineCount,
      dot: "neutral",
      key: "offline",
      label: t(m.computerFilterOffline),
    },
  ];

  const header = searchable ? (
    <div className="mb-1 flex flex-col gap-2 px-1 pt-1 pb-2">
      <div className="relative flex items-center">
        <Icon
          className="pointer-events-none absolute left-2.5 text-muted-foreground"
          icon={Search01Icon}
          size={14}
        />
        <input
          aria-activedescendant={activeId ? optionDomId(activeId) : undefined}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-label={t(m.computerSearchLabel)}
          autoComplete="off"
          className="h-8 w-full rounded-md border border-border bg-background pr-7 pl-8 text-xs text-foreground outline-none transition-colors placeholder:text-app-placeholder hover:border-border-hover focus:border-[var(--app-border-interactive)] focus:ring-2 focus:ring-ring/35"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={t(m.computerSearchPlaceholder)}
          ref={searchInputRef}
          role="searchbox"
          spellCheck={false}
          type="text"
          value={query}
        />
        {query ? (
          <button
            aria-label={t(m.computerSearchClear)}
            className="absolute right-1.5 flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setQuery("");
              searchInputRef.current?.focus();
            }}
            type="button"
          >
            <Icon icon={Cancel01Icon} size={12} />
          </button>
        ) : null}
      </div>
      <div
        aria-label={t(m.computerStatusFilter)}
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
        role="group"
      >
        {filterTabs.map((item) => {
          const active = statusFilter === item.key;
          return (
            <button
              aria-pressed={active}
              className={cn(
                "inline-flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                active
                  ? "bg-card font-medium text-foreground shadow-outline"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={item.key}
              onClick={() => {
                setStatusFilter(item.key);
                searchInputRef.current?.focus();
              }}
              type="button"
            >
              {item.dot ? <StatusDot tone={item.dot} /> : null}
              <span className="truncate">{item.label}</span>
              <span className="tabular-nums text-2xs opacity-70">
                {item.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return createPortal(
    <DropdownOptions
      className="z-[100] m-0 text-app-ink"
      data-computer-picker-popover=""
      data-select-portal=""
      data-side={position.side}
      header={header}
      listProps={{
        "aria-label": t(m.computerPicker),
        id: listboxId,
        onKeyDown: handleListboxKeyDown,
        role: "listbox",
        tabIndex: -1,
      }}
      popover={supportsPopover ? "manual" : undefined}
      ref={popupRef}
      style={style}
    >
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            {query.trim()
              ? t(m.computerEmptyQuery, { query: query.trim() })
              : statusFilter === "online"
                ? t(m.computerEmptyOnline)
                : t(m.computerEmptyOffline)}
          </p>
          {query.trim() || statusFilter !== "all" ? (
            <button
              className="rounded-md px-2 py-1 text-xs font-medium text-foreground underline underline-offset-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={resetFilters}
              type="button"
            >
              {t(m.computerClearFilters)}
            </button>
          ) : null}
        </div>
      ) : showGroups ? (
        <>
          <p
            className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground"
            role="presentation"
          >
            {t(m.computerGroupOnline)}
          </p>
          {onlineFiltered.map(renderOption)}
          <p
            className="mt-1 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
            role="presentation"
          >
            {t(m.computerGroupOffline)}
          </p>
          {offlineFiltered.map(renderOption)}
        </>
      ) : (
        filtered.map(renderOption)
      )}
    </DropdownOptions>,
    portalRoot,
  );
}
