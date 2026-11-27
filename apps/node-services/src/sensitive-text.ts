const REDACTED = "[Redacted]";

/**
 * Masks credentials that appear inside free text such as an error message,
 * where no field name marks them as secret.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
      "[Redacted private key]",
    )
    .replace(
      /data:[^\s,;]+;base64,[A-Za-z0-9+/=_-]+/gi,
      "[Redacted binary data]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/(?:mcp|cli)_ctx_[A-Za-z0-9_-]{43}/gu, REDACTED)
    .replace(
      /(PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*)["']?[A-Za-z0-9_-]+["']?/giu,
      `$1${REDACTED}`,
    )
    .replace(/(\bBearer[ \t]+)[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(
      /(\b(?:proxy-)?authorization[ \t]*[:=][ \t]*Basic[ \t]+)[^\s,;"']+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b((?:proxy-)?authorization)\b([ \t]*[:=][ \t]*)(?![ \t]*(?:Bearer|Basic)[ \t]+\[Redacted\](?=$|[\s,;"'}\])<>]))(?![ \t]*["'[])[^\s\r\n][^\r\n]*/giu,
      `$1$2${REDACTED}`,
    )
    .replace(
      /\b((?:set-)?cookie)\b([ \t]*[:=][ \t]*)(?![ \t]*["'[])[^\s\r\n][^\r\n]*/giu,
      `$1$2${REDACTED}`,
    )
    .replace(
      /((?:"|')?(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|service[_-]?token|secret|token)(?:"|')?\s*:\s*)(?!(?:Bearer|Basic)[ \t]+\[Redacted\])(?!\[Redacted\])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi,
      `$1"${REDACTED}"`,
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|service[_-]?token|secret|token)\s*=\s*)(?!\[Redacted\])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:access_token|api[_-]?key|password|secret|token)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
      `$1${REDACTED}:${REDACTED}@`,
    );
}
