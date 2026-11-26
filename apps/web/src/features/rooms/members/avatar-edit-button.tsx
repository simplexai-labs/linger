import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { Hint } from "@/features/local-computer/computer-hint";

/** An avatar that opens its editor. Pointed at or focused, the avatar dims
 * and a pencil shows at its centre; otherwise the face stays unmarked. */
export function AvatarEditButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Hint placement="bottom" text={label}>
      <button
        aria-label={label}
        className="group relative rounded-[20%] outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
        onClick={onClick}
        type="button"
      >
        {/* Dimming the avatar itself, not a box over it, keeps any shape:
            an Agent's rounded square or a Room's stack of faces. */}
        <span className="block transition-[filter] duration-150 group-hover:brightness-[.55] group-focus-visible:brightness-[.55]">
          {children}
        </span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-primary-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          data-avatar-edit-badge
        >
          <Icon icon={PencilEdit02Icon} size={18} />
        </span>
      </button>
    </Hint>
  );
}
