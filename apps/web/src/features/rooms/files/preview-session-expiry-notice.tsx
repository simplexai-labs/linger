import { RefreshIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/use-translation";
import { filePreviewMessages as m } from "./file-preview.messages";

export function PreviewSessionExpiryNotice({
  expiresAt,
  onRefresh,
}: {
  expiresAt?: string;
  onRefresh: () => void;
}) {
  const t = useT();
  const [expiredAt, setExpiredAt] = useState<string>();

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  if (!expiresAt || expiredAt !== expiresAt) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 bg-app-surface px-3 py-2"
      role="status"
    >
      <p className="text-sm text-app-muted">{t(m.previewExpired)}</p>
      <Button onClick={onRefresh} size="compact" tone="secondary">
        <Icon icon={RefreshIcon} size={14} /> {t(m.refreshPreview)}
      </Button>
    </div>
  );
}
