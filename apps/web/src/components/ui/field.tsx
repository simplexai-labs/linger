import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

export const fieldControlClassName =
  "ui-field-control w-full text-sm text-foreground placeholder:text-app-placeholder disabled:cursor-not-allowed";

export function Field({
  className = "",
  error,
  hint,
  id,
  inputClassName = "",
  label,
  labelAction,
  suffix,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  error?: string | null;
  hint?: ReactNode;
  inputClassName?: string;
  label: string;
  /** A small link or command at the right of the label, such as "Get a key". */
  labelAction?: ReactNode;
  suffix?: ReactNode;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`ui-field ${className}`}>
      {labelAction ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor={inputId}
          >
            {label}
          </label>
          {labelAction}
        </div>
      ) : (
        <label
          className="mb-1.5 block text-sm font-medium text-foreground"
          htmlFor={inputId}
        >
          {label}
        </label>
      )}
      <div className="ui-field-frame">
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`${fieldControlClassName} ${suffix ? "pr-11" : ""} ${inputClassName}`}
          id={inputId}
          {...props}
        />
        {suffix ? (
          <span className="absolute inset-y-0 right-0 flex w-11 items-center justify-center">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1.5 text-xs text-destructive" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
