import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
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
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { localModelsMessages as m } from "./local-models.messages";

export interface ByokComboboxOption {
  /** A second line under the value. */
  detail?: string;
  value: string;
}

function matchesOption(option: ByokComboboxOption, query: string): boolean {
  return (
    option.value.toLowerCase().includes(query) ||
    Boolean(option.detail?.toLowerCase().includes(query))
  );
}

function ByokComboboxMenu({
  focusOptionOnOpen,
  heading,
  id,
  label,
  onChoose,
  onClose,
  options,
  triggerRef,
  value,
}: {
  focusOptionOnOpen: RefObject<boolean>;
  heading?: string;
  id: string;
  label: string;
  onChoose: (value: string) => void;
  onClose: (focusTrigger?: boolean) => void;
  options: readonly ByokComboboxOption[];
  triggerRef: RefObject<HTMLDivElement | null>;
  value: string;
}) {
  const t = useT();
  const { popupRef, portalRoot, position, style, supportsPopover } =
    useAnchoredSelectPopup({
      fixedWidth: true,
      layoutKey: options.length,
      onClose,
      triggerRef,
    });

  useEffect(() => {
    if (!focusOptionOnOpen.current) return;
    focusOptionOnOpen.current = false;
    const menu = popupRef.current;
    (
      menu?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      menu?.querySelector<HTMLElement>('[role="option"]')
    )?.focus();
  }, [focusOptionOnOpen, options.length, popupRef]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose(false);
      return;
    }
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [
      ...(popupRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ??
        []),
    ];
    const at = items.findIndex((item) => item === document.activeElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

  return createPortal(
    <DropdownOptions
      aria-label={t(m.byokSuggestions, { label })}
      className="z-[100] m-0 rounded-xl border border-border/60 p-1.5 text-app-ink shadow-lg"
      data-select-portal=""
      data-side={position.side}
      id={id}
      listClassName="max-h-72 gap-0.5"
      onKeyDown={handleMenuKeyDown}
      onMouseDown={(event) => event.preventDefault()}
      popover={supportsPopover ? "manual" : undefined}
      ref={popupRef}
      role="listbox"
      style={style}
    >
      {heading ? (
        <p className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
          {heading}
        </p>
      ) : null}
      {options.map((option) => (
        <DropdownOption
          aria-label={
            option.detail
              ? `${option.value || "-"} ${option.detail}`
              : option.value || "-"
          }
          aria-selected={option.value === value}
          className="rounded-lg px-2.5 py-2"
          key={option.value}
          labelClassName="w-full max-w-none!"
          onClick={() => onChoose(option.value)}
          role="option"
          tabIndex={-1}
        >
          <span className="block truncate font-mono text-[13px] leading-snug">
            {option.value || "-"}
          </span>
          {option.detail ? (
            <span className="mt-0.5 block truncate text-xs leading-snug text-muted-foreground">
              {option.detail}
            </span>
          ) : null}
        </DropdownOption>
      ))}
    </DropdownOptions>,
    portalRoot,
  );
}

/**
 * A field that takes any typed value and suggests models in a top-layer
 * portaled list anchored to the field width, filtering live as the owner types.
 */
export function ByokCombobox({
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  disabled,
  filled = false,
  heading,
  id,
  inputClassName,
  inputStyle,
  label,
  onCommit,
  onOpenChange,
  onValueChange,
  open,
  options,
  placeholder,
  value,
}: {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  disabled: boolean;
  /** The value is a default Linger filled in, shown in grey. */
  filled?: boolean;
  heading?: string;
  id: string;
  inputClassName?: string;
  inputStyle?: CSSProperties;
  label: string;
  /** Tidies the typed value once the owner leaves the field. */
  onCommit?: () => void;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
  open: boolean;
  options: readonly ByokComboboxOption[];
  placeholder: string;
  value: string;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusOptionOnOpen = useRef(false);
  const [filtering, setFiltering] = useState(false);
  const menuId = `${id}-menu`;

  const visibleOptions = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!filtering || !query) return options;
    return options.filter((option) => matchesOption(option, query));
  }, [filtering, options, value]);

  const showMenu = open && visibleOptions.length > 0;

  function closeMenu(focusInput = false) {
    setFiltering(false);
    onOpenChange(false);
    if (focusInput) inputRef.current?.focus();
  }

  function choose(next: string) {
    setFiltering(false);
    onValueChange(next);
    closeMenu(true);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOptionOnOpen.current = true;
      if (showMenu) {
        const portal = document.getElementById(menuId);
        portal?.querySelector<HTMLElement>('[role="option"]')?.focus();
        focusOptionOnOpen.current = false;
      } else if (options.length > 0) {
        setFiltering(false);
        onOpenChange(true);
      }
    } else if (event.key === "Enter") {
      // Enter settles the typed value rather than submitting the form.
      event.preventDefault();
      onCommit?.();
      closeMenu(false);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(false);
    }
  }

  return (
    <div
      className={cn(
        "relative flex h-10 items-center gap-1 rounded-xl border border-transparent bg-muted/50 pr-1.5 pl-3.5 transition-[background-color,border-color,box-shadow] duration-150 hover:bg-muted/75 focus-within:border-foreground/15 focus-within:bg-card focus-within:shadow-sm has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 motion-reduce:transition-none",
        className,
      )}
      ref={rootRef}
    >
      <input
        aria-autocomplete="list"
        aria-controls={showMenu ? menuId : undefined}
        aria-describedby={ariaDescribedBy}
        aria-expanded={showMenu}
        aria-invalid={ariaInvalid || undefined}
        autoComplete="off"
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed",
          filled ? "text-muted-foreground" : "text-foreground",
          inputClassName,
        )}
        disabled={disabled}
        id={id}
        onBlur={() => onCommit?.()}
        onChange={(event) => {
          const next = event.target.value;
          onValueChange(next);
          if (options.length === 0) return;
          const query = next.trim().toLowerCase();
          const hasMatches =
            !query || options.some((option) => matchesOption(option, query));
          setFiltering(Boolean(query));
          if (hasMatches && !open) onOpenChange(true);
          else if (!hasMatches && open) onOpenChange(false);
        }}
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        style={inputStyle}
        value={value}
      />
      <button
        aria-label={t(m.byokShowSuggestions, { label })}
        className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        disabled={disabled}
        onClick={() => {
          setFiltering(false);
          onOpenChange(!open);
          inputRef.current?.focus();
        }}
        onMouseDown={(event) => event.preventDefault()}
        tabIndex={-1}
        type="button"
      >
        <Icon
          className={cn("transition-transform", showMenu && "rotate-180")}
          icon={ArrowDown01Icon}
          size={15}
        />
      </button>
      {showMenu ? (
        <ByokComboboxMenu
          focusOptionOnOpen={focusOptionOnOpen}
          heading={heading}
          id={menuId}
          label={label}
          onChoose={choose}
          onClose={closeMenu}
          options={visibleOptions}
          triggerRef={rootRef}
          value={value}
        />
      ) : null}
    </div>
  );
}
