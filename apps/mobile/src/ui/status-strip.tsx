// The one line above a screen that says what is wrong, and nothing when all
// is well. Reaching the computer and Another Me being able to run tasks are
// separate: quitting Desktop stops tasks while TeamHub keeps serving.
import { useEffect, useState } from "react";

import { useComputer } from "../computer/computer-context";
import { useTranslation } from "../i18n/use-translation";
import { useAnotherMeCanRunTasks } from "../state/queries";
import { Notice } from "./controls";
import { statusStripMessages as m } from "./status-strip.messages";

/** Brief reconnects should not flash a banner. */
const CONNECTING_GRACE_MS = 1_500;

function useDelayed(value: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return value && shown;
}

export function StatusStrip() {
  const { t } = useTranslation();
  const { active, status, retryNow } = useComputer();
  const canRunTasks = useAnotherMeCanRunTasks();
  const connecting = useDelayed(
    status?.kind === "connecting",
    CONNECTING_GRACE_MS,
  );
  const name = active?.name ?? t(m.yourComputer);

  if (status?.kind === "offline")
    return (
      <Notice
        tone="warning"
        text={t(m.offline, { name })}
        action={{ label: t(m.retry), onPress: retryNow }}
      />
    );
  if (connecting)
    return <Notice tone="neutral" text={t(m.connecting, { name })} />;
  if (status?.kind === "pending")
    return <Notice tone="info" text={t(m.approve, { name })} />;
  if (status?.kind === "connected" && canRunTasks === false)
    return <Notice tone="warning" text={t(m.cannotRunTasks)} />;
  return null;
}
