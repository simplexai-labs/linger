import {
  Add01Icon,
  AlertCircleIcon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { ComputerDeviceIcon } from "./computer-app-brand-icon";
import { computerSetupMessages } from "./computer-setup.messages";
import { ComputerSetupInstructions } from "./computer-setup-instructions";
import { computersMessages } from "./computers.messages";
import { ServerConnection } from "./server-connection";

export function UnavailableComputer({
  onBack,
  onConnect,
}: {
  onBack: () => void;
  onConnect?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-center rounded-xl border border-border bg-card px-6 py-14 text-center">
      <div className="max-w-md">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground">
          <Icon icon={AlertCircleIcon} size={22} />
        </span>
        <h2 className="mt-4 text-lg font-medium text-foreground">
          {t(computersMessages.unavailableTitle)}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t(computersMessages.unavailableBody)}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={onBack} tone="primary">
            {t(computersMessages.backToComputers)}
          </Button>
          {onConnect ? (
            <Button onClick={onConnect}>
              <Icon icon={ComputerTerminal01Icon} size={16} />
              {t(computersMessages.setupCommands)}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ConnectComputerDialog({
  tenantId,
  connected,
  onClose,
  onDone,
}: {
  tenantId?: string;
  connected: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title={t(computersMessages.connectDialogTitle)}
      footer={
        <>
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button disabled={!connected} onClick={onDone} tone="primary">
            {t(commonMessages.done)}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <ComputerSetupInstructions connected={connected} />
        {tenantId && <ServerConnection key={tenantId} tenantId={tenantId} />}
      </div>
    </ModalDialog>
  );
}

/** Every Computer was removed; the built-in local Computer normally prevents this. */
export function NoComputers({ onConnect }: { onConnect?: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center rounded-2xl bg-card px-6 py-14 text-center shadow-outline">
      <ComputerDeviceIcon online size={56} />
      <h2 className="mt-4 text-lg font-medium text-foreground">
        {t(computersMessages.noComputersTitle)}
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {t(computersMessages.noComputersBody)}
      </p>
      {onConnect ? (
        <Button className="mt-6" onClick={onConnect} tone="primary">
          <Icon icon={Add01Icon} size={14} />
          {t(computerSetupMessages.title)}
        </Button>
      ) : null}
    </div>
  );
}
