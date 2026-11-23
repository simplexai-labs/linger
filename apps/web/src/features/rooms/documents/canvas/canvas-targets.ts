// Where a canvas is delivered. Adding a target only needs an entry here and
// the matching skills/builtin/canvas target guide for the Agent.

import type { Message } from "@/i18n/messages";
import { canvasMessages } from "./canvas.messages";

/**
 * A field of the canvas header. A registered target words its fields with
 * messages; a field read from an unknown target shows its key as it is.
 */
export interface CanvasTargetField {
  key: string;
  label: string | Message<string>;
  placeholder?: string | Message<string>;
}

export interface CanvasTarget {
  id: string;
  label: string;
  fields: CanvasTargetField[];
}

const mailFields: CanvasTargetField[] = [
  { key: "to", label: canvasMessages.to, placeholder: "name@example.com" },
  {
    key: "cc",
    label: canvasMessages.cc,
    placeholder: canvasMessages.addRecipients,
  },
  { key: "subject", label: canvasMessages.subject },
];

export const canvasTargets: Record<string, CanvasTarget> = {
  gmail: { id: "gmail", label: "Gmail", fields: mailFields },
  outlook: { id: "outlook", label: "Outlook", fields: mailFields },
  feishu_mail: { id: "feishu_mail", label: "Feishu Mail", fields: mailFields },
};

/**
 * Whether a canvas of target is an email, sent from a connected account of
 * that mail app; the target is the app's catalog key.
 */
export function isMailCanvasTarget(target: string | null | undefined) {
  return target === "gmail" || target === "feishu_mail" || target === "outlook";
}

/** The mail app a mail canvas target sends from, by name. */
export function mailCanvasAppName(target: string | null | undefined) {
  return canvasTargets[target ?? "gmail"]?.label ?? "Gmail";
}

/** Fields every canvas shares, whatever its target. */
export const canvasStatusKeys = ["status", "link", "external_id"] as const;
