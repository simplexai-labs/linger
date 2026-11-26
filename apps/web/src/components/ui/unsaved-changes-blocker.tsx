import { useContext } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { uiExtrasMessages } from "./ui-extras.messages";

interface UnsavedChangesBlockerProps {
  description?: string;
  title?: string;
  when: boolean;
}

/**
 * Guards in-app route navigation when a form has unsaved edits, showing a
 * confirmation dialog before discarding. Safely no-ops when rendered outside a
 * React Router data router (such as isolated MemoryRouter unit tests).
 */
export function UnsavedChangesBlocker(props: UnsavedChangesBlockerProps) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  if (!dataRouter) return null;
  return <DataRouterUnsavedBlocker {...props} />;
}

function DataRouterUnsavedBlocker({
  description,
  title,
  when,
}: UnsavedChangesBlockerProps) {
  const t = useT();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && currentLocation.pathname !== nextLocation.pathname,
  );

  if (blocker.state !== "blocked") return null;

  return (
    <ModalDialog
      description={description ?? t(uiExtrasMessages.discardUnsavedDescription)}
      footer={
        <>
          <Button onClick={() => blocker.reset()} size="compact">
            {t(commonMessages.cancel)}
          </Button>
          <Button
            data-voice-risk="never"
            onClick={() => blocker.proceed()}
            size="compact"
            tone="danger"
          >
            {t(uiExtrasMessages.discardChanges)}
          </Button>
        </>
      }
      onClose={() => blocker.reset()}
      size="sm"
      title={title ?? t(uiExtrasMessages.discardUnsavedTitle)}
    >
      {null}
    </ModalDialog>
  );
}
