import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";

import {
  DropdownOption,
  DropdownOptions,
} from "@/components/ui/dropdown-options";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { localModelsMessages as m } from "./local-models.messages";

export interface ByokComboboxOption {
  /** A second line under the value. */
  detail?: string;
  value: string;
}

/**
 * A field that takes any typed value and suggests some in a list, which
 * opens from its caret or the Down key. An empty value shows as "-".
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
  menuClassName = "-left-px",
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
  /** Which edge of the box the suggestions line up with; the left by default. */
  menuClassName?: string;
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
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOptionOnOpen = useRef(false);
  const menuId = `${id}-menu`;
  const close = useEffectEvent(() => onOpenChange(false));

  useEffect(() => {
    if (!open) return undefined;
    if (focusOptionOnOpen.current) {
      focusOptionOnOpen.current = false;
      const menu = menuRef.current;
      (
        menu?.querySelector<HTMLElement>('[aria-selected="true"]') ??
        menu?.querySelector<HTMLElement>('[role="option"]')
      )?.focus();
    }
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function closeToInput() {
    onOpenChange(false);
    inputRef.current?.focus();
  }

  function choose(next: string) {
    onValueChange(next);
    closeToInput();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOptionOnOpen.current = true;
      if (open) {
        menuRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
        focusOptionOnOpen.current = false;
      } else onOpenChange(true);
    } else if (event.key === "Enter") {
      // Enter settles the typed value rather than submitting the form.
      event.preventDefault();
      onCommit?.();
      onOpenChange(false);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeToInput();
      return;
    }
    if (event.key === "Tab") {
      onOpenChange(false);
      return;
    }
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ??
        []),
    ];
    const at = items.findIndex((item) => item === document.activeElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

  return (
    <div
      className={cn(
        "ui-field-control relative flex items-center gap-1 py-0 pr-1 focus-within:border-[var(--app-field-focus)] focus-within:shadow-[0_0_0_2px_var(--app-ring)] has-[:disabled]:bg-[var(--app-field-disabled-surface)]",
        className,
      )}
      ref={rootRef}
    >
      <input
        aria-autocomplete="none"
        aria-controls={open ? menuId : undefined}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-invalid={ariaInvalid || undefined}
        autoComplete="off"
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-app-placeholder disabled:cursor-not-allowed",
          filled ? "text-muted-foreground" : "text-foreground",
          inputClassName,
        )}
        disabled={disabled}
        id={id}
        onBlur={() => onCommit?.()}
        onChange={(event) => {
          onValueChange(event.target.value);
          if (open) onOpenChange(false);
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
        className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        disabled={disabled}
        onClick={() => {
          onOpenChange(!open);
          inputRef.current?.focus();
        }}
        onMouseDown={(event) => event.preventDefault()}
        tabIndex={-1}
        type="button"
      >
        <Icon
          className={cn("transition-transform", open && "rotate-180")}
          icon={ArrowDown01Icon}
          size={14}
        />
      </button>
      {open && options.length ? (
        <DropdownOptions
          aria-label={t(m.byokSuggestions, { label })}
          className={cn(
            "absolute top-full z-30 mt-1 w-max min-w-[calc(100%+2px)] max-w-[min(22rem,86vw)]",
            menuClassName,
          )}
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          onMouseDown={(event) => event.preventDefault()}
          ref={menuRef}
          role="listbox"
        >
          {heading ? (
            <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
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
              key={option.value}
              onClick={() => choose(option.value)}
              role="option"
              tabIndex={-1}
            >
              <span className="block truncate font-mono text-xs">
                {option.value || "-"}
              </span>
              {option.detail ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {option.detail}
                </span>
              ) : null}
            </DropdownOption>
          ))}
        </DropdownOptions>
      ) : null}
    </div>
  );
}
