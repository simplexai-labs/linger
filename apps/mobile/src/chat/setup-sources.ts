// The links and files an Another Me sources card shares, within TeamHub's
// answer limits. Links are parsed by hand: React Native's URL does not
// implement every getter.

export const MAX_LINKS = 5;
export const MAX_FILES = 5;
const MAX_LINK_LENGTH = 2048;

const LINK = /^https?:\/\/([^\s/?#]+)([^\s?#]*)(\?[^\s#]*)?(#\S*)?$/iu;

/** Why a link cannot be added, or undefined when it can. */
export type LinkProblem = "invalid" | "duplicate" | "limit";

/** An absolute http(s) link with a host and no whitespace. */
export function isSourceLink(value: string): boolean {
  return value.length <= MAX_LINK_LENGTH && LINK.test(value);
}

export function linkProblem(
  link: string,
  added: readonly string[],
): LinkProblem | undefined {
  if (!isSourceLink(link)) return "invalid";
  if (added.includes(link)) return "duplicate";
  if (added.length >= MAX_LINKS) return "limit";
  return undefined;
}

/** A link as a row shows it: the host, then any path and query. */
export function linkLabel(link: string): string {
  const match = LINK.exec(link);
  if (!match) return link;
  const host = match[1] ?? "";
  const path = match[2] ?? "";
  const search = match[3] ?? "";
  return (path === "" || path === "/") && !search
    ? host
    : `${host}${path}${search}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
