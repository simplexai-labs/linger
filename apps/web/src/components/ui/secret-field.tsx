import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { type InputHTMLAttributes, type Ref, useId, useState } from "react";

import { fieldControlClassName } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { uiExtrasMessages } from "./ui-extras.messages";

type SecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "type"
> & {
  frameClassName?: string;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
};

/**
 * Password or API-key input with an accessible visibility toggle. Use this
 * directly when the caller owns its own label/hint layout, or use `SecretField`
 * for the standard stacked field layout.
 */
export function SecretInput({
  className,
  disabled,
  frameClassName,
  inputClassName,
  inputRef,
  ...props
}: SecretInputProps) {
  const t = useT();
  const [visible, setVisible] = useState(false);

  return (
    <div className={cn("ui-field-frame", frameClassName)}>
      <input
        {...props}
        className={cn(
          fieldControlClassName,
          "pr-11",
          className,
          inputClassName,
        )}
        disabled={disabled}
        ref={inputRef}
        type={visible ? "text" : "password"}
      />
      <span className="absolute inset-y-0 right-0 flex w-11 items-center justify-center">
        <button
          aria-label={t(
            visible ? uiExtrasMessages.maskValue : uiExtrasMessages.showValue,
          )}
          aria-pressed={visible}
          className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none"
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          <Icon icon={visible ? ViewOffIcon : ViewIcon} size={16} />
        </button>
      </span>
    </div>
  );
}

/**
 * Standard labeled secret input (passwords, API keys, tokens) with Show/Mask
 * toggle, optional hint, and accessible error association.
 */
export function SecretField({
  className = "",
  error,
  hint,
  id,
  inputClassName = "",
  inputRef,
  label,
  ...props
}: SecretInputProps & {
  error?: string | null;
  hint?: string;
  label: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("ui-field", className)}>
      <label
        className="mb-1.5 block text-sm font-medium text-foreground"
        htmlFor={inputId}
      >
        {label}
      </label>
      <SecretInput
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        id={inputId}
        inputClassName={inputClassName}
        inputRef={inputRef}
      />
      {hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          className="mt-1.5 text-xs text-destructive"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
