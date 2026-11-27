import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { Hint } from "@/features/local-computer/computer-hint";

/**
 * An avatar that opens its editor. Pointed at or focused, a dark veil and a
 * pencil cover it; otherwise the face stays unmarked. A veil, not a brightness
 * filter, so a Human's translucent initials tile dims as much as a portrait.
 */
export function AvatarEditButton({
  children,
  disabled = false,
  label,
  onClick,
}: {
  /** The avatar; give it no native title, as the hint already names it. */
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Hint placement="bottom" text={label}>
      <button
        aria-label={label}
        className="group relative block rounded-[20%] outline-none focus-visible:ring-2 focus-visible:ring-app-focus disabled:opacity-50"
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {/* Initials hide under the veil so only the pencil reads. */}
        <span className="block group-hover:*:text-transparent group-focus-visible:*:text-transparent">
          {children}
        </span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20%] bg-black/45 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
          data-avatar-edit-badge
        >
          <Icon icon={PencilEdit02Icon} size={18} />
        </span>
      </button>
    </Hint>
  );
}
