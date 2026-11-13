import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Cancels one Task's current turn. The Room's Meta is told and can resume
 * it later, so no confirmation is asked.
 */
export function CancelTaskButton({
  cancel,
  prominent = false,
  title,
}: {
  cancel: () => Promise<void>;
  /** A dialog's own action button, rather than a quiet link in a list row. */
  prominent?: boolean;
  title: string;
}) {
  const [state, setState] = useState<"idle" | "pending" | "error">("idle");
  return (
    <Button
      aria-label={
        state === "error"
          ? `Cancel of ${title} was not confirmed; retry`
          : `Cancel ${title}`
      }
      className={cn(
        !prominent &&
          "h-7 px-1.5 text-[12px] font-medium hover:bg-transparent hover:text-app-danger",
        state === "error" ? "text-app-danger" : !prominent && "text-app-muted",
      )}
      disabled={state === "pending"}
      onClick={() => {
        setState("pending");
        cancel().then(
          () => setState("idle"),
          () => setState("error"),
        );
      }}
      size="compact"
      tone={prominent ? "secondary" : "ghost"}
      type="button"
    >
      {state === "pending"
        ? "Canceling"
        : state === "error"
          ? "Retry"
          : prominent
            ? "Cancel task"
            : "Cancel"}
    </Button>
  );
}
