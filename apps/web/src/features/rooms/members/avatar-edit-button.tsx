import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { Hint } from "@/features/local-computer/computer-hint";

/** An avatar that opens its editor. The pencil appears over its centre only
 * while the avatar is pointed at or focused, so the face stays unmarked. */
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
        {children}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto flex size-7 items-center justify-center rounded-full bg-card text-foreground opacity-0 shadow-outline transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          data-avatar-edit-badge
        >
          <Icon icon={PencilEdit02Icon} size={14} />
        </span>
      </button>
    </Hint>
  );
}
