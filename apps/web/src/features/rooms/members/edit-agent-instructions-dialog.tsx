import { type FormEvent, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { agentInfoMessages } from "./agent-info.messages";
import { presentAgentInstructions } from "./agent-instruction-text";

export function EditAgentInstructionsDialog({
  instructions,
  canEdit,
  error,
  isPending,
  onClose,
  onSave,
}: {
  instructions: string;
  canEdit: boolean;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onSave: (input: { instructions: string }) => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState(() =>
    presentAgentInstructions(instructions),
  );
  const disabled = !canEdit || isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !draft.trim()) return;
    onSave({ instructions: draft });
  }

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title={t(agentInfoMessages.editInstructions)}
      footer={
        <>
          <Button data-voice-close onClick={onClose} type="button">
            {t(canEdit ? commonMessages.cancel : commonMessages.close)}
          </Button>
          {canEdit ? (
            <Button
              disabled={disabled || !draft.trim()}
              form={formId}
              loading={isPending}
              tone="primary"
              type="submit"
            >
              {t(commonMessages.save)}
            </Button>
          ) : null}
        </>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={submit}>
        <textarea
          aria-label={t(agentInfoMessages.agentInstructions)}
          className="min-h-64 w-full resize-y rounded-md border border-border bg-card px-3 py-2.5 text-sm leading-6 text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-app-placeholder hover:border-border-hover focus:border-foreground focus:ring-2 focus:ring-ring disabled:opacity-60"
          disabled={disabled}
          maxLength={50000}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t(agentInfoMessages.instructionsUnset)}
          value={draft}
        />
        {error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
