import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
} from "react";

import { Icon } from "@/components/ui/icon";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

export type DialogSize = "sm" | "md" | "lg" | "xl";

interface DialogCloseButtonProps {
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}

export function DialogCloseButton({ onClick, ref }: DialogCloseButtonProps) {
  const t = useT();
  return (
    <button
      aria-label={t(commonMessages.close)}
      className="app-dialog-close"
      data-voice-close
      onClick={onClick}
      ref={ref}
      type="button"
    >
      <Icon icon={Cancel01Icon} size={16} />
    </button>
  );
}

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function firstFocusable(root: Element | null): HTMLElement | null {
  if (!root) {
    return null;
  }

  for (const element of root.querySelectorAll<HTMLElement>(focusableSelector)) {
    if (!element.closest("[inert]")) {
      return element;
    }
  }

  return null;
}

export function ModalDialog({
  ariaLabel,
  children,
  className = "",
  closeOnBackdrop = false,
  description,
  footer,
  onClose,
  size,
  title,
}: {
  /** Used when no `title` names the dialog; a titled dialog labels itself. */
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  /** Optional subtitle under the title. */
  description?: ReactNode;
  /** Right-aligned action row; omitted dialogs render no footer. */
  footer?: ReactNode;
  onClose: () => void;
  /** One of four standard widths; omit for a full-screen or custom frame. */
  size?: DialogSize;
  /** Rendering a title opts the dialog into the shared header/body/footer chrome. */
  title?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeFromBackdrop = useEffectEvent(() => onClose());
  const headingId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const standard = title !== undefined;

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) {
        dialog.showModal();
        // showModal focuses the header close button first; keep initial focus
        // on the content. Moving focus on from a focused control would mark it
        // keyboard focus, so the first row or field lit up on every open; it
        // shows only once the person uses the keyboard.
        const close = closeButtonRef.current;
        if (close && document.activeElement === close) {
          // A control marked data-autofocus starts the dialog; React's
          // autoFocus never reaches the DOM, so showModal() cannot see it.
          const target =
            dialog.querySelector<HTMLElement>("[data-autofocus]") ??
            firstFocusable(dialog.querySelector(".app-dialog-body")) ??
            firstFocusable(dialog.querySelector(".app-dialog-footer")) ??
            close;
          // Refocusing the close button itself would keep its ring, so it
          // lets go first.
          close.blur();
          target.focus({ focusVisible: false });
        }
      }
    } else {
      dialog.setAttribute("open", "");
    }

    return () => {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog || !closeOnBackdrop) {
      return;
    }

    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target === dialog) closeFromBackdrop();
    };
    dialog.addEventListener("click", handleBackdropClick);
    return () => dialog.removeEventListener("click", handleBackdropClick);
  }, [closeOnBackdrop]);

  return (
    <dialog
      aria-label={standard ? undefined : ariaLabel}
      aria-labelledby={standard ? headingId : undefined}
      className={`app-dialog ${standard ? "app-dialog-standard" : ""} ${className}`}
      data-size={size}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      {standard ? (
        <>
          <header className="app-dialog-header">
            <div className="min-w-0 flex-1">
              <h2 className="app-dialog-title" id={headingId}>
                {title}
              </h2>
              {description !== undefined ? (
                <p className="app-dialog-description">{description}</p>
              ) : null}
            </div>
            <DialogCloseButton onClick={onClose} ref={closeButtonRef} />
          </header>
          <div className="app-dialog-body">{children}</div>
          {footer !== undefined ? (
            <footer className="app-dialog-footer">{footer}</footer>
          ) : null}
        </>
      ) : (
        children
      )}
    </dialog>
  );
}
