/** Turns a failed localmodels run into a short cause and a redacted log. */
import { redact } from "./redaction.js";

export interface LocalmodelsFailure {
  /** The upstream error code, when its JSON error line was present. */
  code?: string;
  /** The upstream stack cause code (for example STACK_REPLAN_FAILED), when present. */
  causeCode?: string;
  /** One redacted line naming the cause, fit for the setup page. */
  cause?: string;
  /** Redacted stdout and stderr, split to fit installer log events. */
  log: string[];
}

const LOG_PART = 1800;
const LOG_PARTS = 8;

/** Removes credentials, signed URL parameters and terminal bytes. */
export function redactLocalmodelsOutput(text: string): string {
  return (
    redact(text)
      // Signed download redirects carry their credential in the query.
      .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+)\?[^\s"']*/gi,
        "$1?[REDACTED]",
      )
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
      .replace(/\b(?:gh[pousr]|glpat)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]")
      // eslint-disable-next-line no-control-regex -- Strip control bytes from upstream output.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

function line(text: string, keepEnd = false): string | undefined {
  const value = redactLocalmodelsOutput(text).replace(/\s+/g, " ").trim();
  if (!value || value.length <= 300) return value || undefined;
  return keepEnd ? `…${value.slice(-299)}` : `${value.slice(0, 299)}…`;
}

interface ParsedErrorEvent {
  code?: string;
  causeCode?: string;
  message?: string;
  reason?: string;
  host?: string;
}

const SAFE_TOKEN = /^[a-z][a-z0-9_-]{0,40}$/;

const STACK_CAUSE_MESSAGES: Record<string, string> = {
  STACK_REPLAN_FAILED:
    "The saved local model plan no longer fits this computer's current memory or model catalog.",
  STACK_PLAN_CHANGED:
    "This computer's state or local model runtime changed since the plan was approved.",
  STACK_APPROVAL_MISMATCH:
    "The saved local model plan no longer matches its approval code.",
  STACK_APPLY_LOCKED: "Another local model operation is already running.",
  STACK_APPLY_INTERRUPTED: "The local model operation was interrupted.",
  STACK_COMPONENT_FAILED: "A local model component did not pass verification.",
  SEARCH_UNAVAILABLE: "No free web search engine answered from this network.",
  STACK_APPLY_FAILED: "Applying the local model plan did not finish.",
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractEvent(value: unknown): ParsedErrorEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const event = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof event[key] === "string" && event[key].trim()
      ? event[key].trim()
      : undefined;

  if (event.schema === "localmodels.stack-error/v1") {
    const code = text("code") ?? "STACK_APPLY_FAILED";
    const causeCode = text("causeCode");
    const changedFields = Array.isArray(event.changedFields)
      ? event.changedFields.filter(
          (field): field is string =>
            typeof field === "string" && SAFE_TOKEN.test(field),
        )
      : [];
    const message =
      causeCode === "STACK_PLAN_CHANGED" && changedFields.length > 0
        ? `This computer's state or local model runtime changed since the plan was approved (${changedFields.join(", ")}).`
        : causeCode && Object.hasOwn(STACK_CAUSE_MESSAGES, causeCode)
          ? STACK_CAUSE_MESSAGES[causeCode]
          : (text("message") ?? STACK_CAUSE_MESSAGES.STACK_APPLY_FAILED);
    return { code, causeCode, message };
  }

  if (event.event === "result" && event.ok === false) {
    const causeCode = text("causeCode");
    const failed = Array.isArray(event.components)
      ? event.components.flatMap((entry) => {
          const item = entry as { component?: unknown; status?: unknown };
          return typeof item?.component === "string" &&
            SAFE_TOKEN.test(item.component) &&
            item.status !== "ok"
            ? [item.component]
            : [];
        })
      : [];
    const message =
      causeCode === "SEARCH_UNAVAILABLE"
        ? STACK_CAUSE_MESSAGES.SEARCH_UNAVAILABLE
        : failed.length > 0
          ? `Local model setup failed at: ${failed.join(", ")}.`
          : causeCode && Object.hasOwn(STACK_CAUSE_MESSAGES, causeCode)
            ? STACK_CAUSE_MESSAGES[causeCode]
            : STACK_CAUSE_MESSAGES.STACK_APPLY_FAILED;
    return { code: "STACK_APPLY_FAILED", causeCode, message };
  }

  if (event.schema === "localmodels.stack-up/v1" && event.ok === false) {
    const parts = Array.isArray(event.parts)
      ? (event.parts as Record<string, unknown>[])
      : [];
    const failedPart = parts.find(
      (part) =>
        part?.action === "failed" ||
        part?.state !== "active" ||
        (part?.health !== "ok" && part?.health !== "ready"),
    );
    const partName =
      typeof failedPart?.name === "string" && failedPart.name.trim()
        ? failedPart.name.trim()
        : undefined;
    const partDetail =
      typeof failedPart?.detail === "string" && failedPart.detail.trim()
        ? failedPart.detail.trim()
        : undefined;
    const gateway = text("gateway");
    const message = partDetail
      ? partName
        ? `${partName}: ${partDetail}`
        : partDetail
      : partName
        ? `${partName} did not become ready.`
        : gateway && gateway !== "started" && gateway !== "reused"
          ? `Local model gateway failed: ${gateway}`
          : "The installed local model stack did not start.";
    return { code: "STACK_UP_FAILED", message };
  }

  if (
    (typeof event.schema === "string" &&
      /^localmodels\.[a-z-]+-error\/v1$/.test(event.schema)) ||
    event.kind === "error"
  ) {
    return {
      code: text("code"),
      message: text("message"),
      reason: text("reason"),
      host: text("host"),
    };
  }
  return undefined;
}

function errorEvent(text: string): ParsedErrorEvent | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const whole = extractEvent(parseJson(trimmed));
  if (whole) return whole;
  for (const raw of trimmed.split("\n").reverse()) {
    const found = extractEvent(parseJson(raw));
    if (found) return found;
  }
  return undefined;
}

export function localmodelsFailure(
  args: string[],
  result: { code: number; stdout: string; stderr: string },
): LocalmodelsFailure {
  const event = errorEvent(result.stdout) ?? errorEvent(result.stderr);
  let cause = event?.message ? line(event.message) : undefined;
  if (!cause && event?.reason)
    cause = line(event.host ? `${event.host}: ${event.reason}` : event.reason);
  if (!cause) {
    const tail = result.stderr
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ");
    // A traceback ends with its cause.
    cause = line(tail, true);
  }
  // Byte progress repeats thousands of times and says nothing about the cause.
  const stdout = result.stdout
    .split("\n")
    .filter((item) => !/^\{"(?:kind|event)": ?"progress"/.test(item.trim()))
    .join("\n")
    .trim();
  const detailCode = event?.causeCode ?? event?.code;
  const full = redactLocalmodelsOutput(
    [
      `localmodels ${args.slice(0, 2).join(" ")} exited with code ${result.code}${detailCode ? ` (${detailCode})` : ""}.`,
      stdout && `stdout:\n${stdout}`,
      result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const log: string[] = [];
  for (let at = 0; at < full.length; at += LOG_PART)
    log.push(full.slice(at, at + LOG_PART));
  // The end holds the error line and any traceback.
  if (log.length > LOG_PARTS)
    log.splice(1, log.length - LOG_PARTS, "[earlier output omitted]");
  return {
    ...(event?.code ? { code: event.code } : {}),
    ...(event?.causeCode ? { causeCode: event.causeCode } : {}),
    cause,
    log,
  };
}
