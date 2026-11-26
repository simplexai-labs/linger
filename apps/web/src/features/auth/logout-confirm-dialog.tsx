import { createRoot } from "react-dom/client";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { authMessages } from "./auth.messages";

function LogoutConfirmModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <ModalDialog
      description={t(authMessages.logoutUnsavedDocuments)}
      footer={
        <>
          <Button onClick={onCancel} size="compact">
            {t(commonMessages.cancel)}
          </Button>
          <Button
            data-voice-risk="never"
            onClick={onConfirm}
            size="compact"
            tone="danger"
          >
            {t(authMessages.logoutAndDiscard)}
          </Button>
        </>
      }
      onClose={onCancel}
      size="sm"
      title={t(authMessages.logoutUnsavedDocumentsTitle)}
    >
      {null}
    </ModalDialog>
  );
}

/**
 * Opens an in-app confirmation modal before logging out with unsaved Document
 * edits, replacing browser `window.confirm()`. Returns both the user's answer
 * promise and a cleanup callback for caller unmount.
 */
export function openLogoutConfirmDialog(): {
  cancel: () => void;
  promise: Promise<boolean>;
} {
  let settled = false;
  let resolveChoice!: (confirmed: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveChoice = resolve;
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function finish(confirmed: boolean) {
    if (settled) return;
    settled = true;
    root.unmount();
    container.remove();
    resolveChoice(confirmed);
  }

  root.render(
    <LogoutConfirmModal
      onCancel={() => finish(false)}
      onConfirm={() => finish(true)}
    />,
  );

  return {
    cancel: () => finish(false),
    promise,
  };
}
