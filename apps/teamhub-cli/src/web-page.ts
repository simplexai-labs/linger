import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { CommandExecutionContext } from "./command-definition.js";
import { ConnectorError } from "./errors.js";

/** The same cut TeamHub applies to a page a provider opened. */
export const maxMarkdownCharacters = 20000;
const maxTitleCharacters = 300;
const maxURLBytes = 2048;
// Pages are read whole before conversion; past this the rest is dropped and
// the page is reported truncated.
const maxPageBytes = 5 * 1024 * 1024;
const fetchTimeoutMs = 30000;

export interface WebPage {
  url: string;
  title?: string;
  markdown: string;
  truncated: boolean;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const alwaysDropped = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "dialog",
  "nav",
  "link",
  "meta",
]);
// Never page text, even inside code.
const codeDropped = new Set(["script", "style", "template", "noscript"]);
// Site chrome around the page's text; dropped only when the page marks no
// main or article element, since an article's own header holds its title.
const chrome = new Set(["header", "footer", "aside"]);
// Landmarks and widgets that are never the page's text.
const droppedRoles = new Set([
  "navigation",
  "search",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "dialog",
]);

const unreadable = (message: string) =>
  new ConnectorError("page_unreadable", message);

/** True for an absolute http or https URL within the contract's bound. */
export function webURL(value: string): boolean {
  if (!value || Buffer.byteLength(value) > maxURLBytes) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Opens a page from this computer, so it reaches what the user's own browser
 * reaches, and converts HTML to Markdown cut at the same length TeamHub uses.
 */
export async function openDirect(
  url: string,
  context: Pick<CommandExecutionContext, "fetch">,
): Promise<WebPage> {
  let response: Response;
  try {
    response = await (context.fetch ?? globalThis.fetch)(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: {
        accept:
          "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,*/*;q=0.1",
        "user-agent": "Mozilla/5.0 (compatible; teamhub-cli)",
      },
    });
  } catch {
    throw unreadable(
      "The page could not be reached from this computer. Check the URL, or try a provider backend with --backend (teamhub web list shows the ready ones).",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw unreadable(
      `The site answered HTTP ${response.status}. Try a provider backend with --backend (teamhub web list shows the ready ones).`,
    );
  }
  const contentType = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .trim();
  const mediaType = contentType.split(";", 1)[0]!.trim();
  const html =
    mediaType === "text/html" || mediaType === "application/xhtml+xml";
  if (
    !html &&
    !mediaType.startsWith("text/") &&
    mediaType !== "application/json" &&
    mediaType !== ""
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw unreadable(
      `The page is ${mediaType}, not HTML or text. Try a provider backend with --backend; some read documents such as PDFs.`,
    );
  }
  const { bytes, cut } = await readPage(response);
  const text = decode(bytes, contentType, html || mediaType === "");
  const finalURL = webURL(response.url) ? response.url : url;
  const page =
    html || (mediaType === "" && /^\s*<(?:!doctype|html)/iu.test(text))
      ? await htmlToMarkdown(text, finalURL)
      : { markdown: text.trim() };
  if (!page.markdown)
    throw unreadable(
      "The page has no readable text; it may need JavaScript. Try a provider backend with --backend.",
    );
  const characters = Array.from(page.markdown);
  return {
    url: finalURL,
    ...(page.title ? { title: page.title } : {}),
    markdown:
      characters.length > maxMarkdownCharacters
        ? characters.slice(0, maxMarkdownCharacters).join("")
        : page.markdown,
    truncated: cut || characters.length > maxMarkdownCharacters,
  };
}

async function readPage(
  response: Response,
): Promise<{ bytes: Buffer; cut: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { bytes: Buffer.concat(chunks, size), cut: false };
      const room = maxPageBytes - size;
      if (next.value.byteLength >= room) {
        chunks.push(next.value.subarray(0, room));
        return { bytes: Buffer.concat(chunks, maxPageBytes), cut: true };
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch {
    throw unreadable(
      "The page stopped loading before it finished. Run the command again, or try a provider backend with --backend.",
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Decodes with the served charset, else an HTML meta charset, else UTF-8. */
function decode(bytes: Buffer, contentType: string, sniff: boolean): string {
  let label = /charset\s*=\s*"?([\w.:-]+)/iu.exec(contentType)?.[1];
  if (!label && sniff)
    label = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/iu.exec(
      bytes.subarray(0, 4096).toString("latin1"),
    )?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Converts a page's main content to GitHub-flavored Markdown. */
export async function htmlToMarkdown(
  html: string,
  pageURL: string,
): Promise<{ title?: string; markdown: string }> {
  const tree = unified().use(rehypeParse).parse(html) as unknown as HastNode;
  const baseHref = findAll(tree, "base").find(
    (node) => typeof node.properties?.href === "string",
  )?.properties?.href;
  const baseURL =
    typeof baseHref === "string" ? resolve(baseHref, pageURL) : undefined;
  const title = plainText(textOf(find(tree, "title")))
    .slice(0, maxTitleCharacters)
    .trim();
  // A lone article is the page's text; several are a feed inside main.
  const articles = findAll(tree, "article");
  const content =
    (articles.length === 1 ? articles[0] : undefined) ??
    find(tree, "main") ??
    articles[0] ??
    find(tree, "body") ??
    tree;
  prune(
    content,
    content.tagName === "body" || content === tree,
    baseURL && webURL(baseURL) ? baseURL : pageURL,
  );
  const root = { type: "root", children: [content] };
  const mdast = await unified()
    .use(rehypeRemark)
    .run(root as never);
  const markdown = unified()
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkStringify, { bullet: "-", fences: true, rule: "-" })
    .stringify(mdast);
  return {
    ...(title ? { title } : {}),
    markdown: markdown.replace(/\n{3,}/gu, "\n\n").trim(),
  };
}

function find(node: HastNode, tagName: string): HastNode | undefined {
  if (node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = find(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function findAll(node: HastNode, tagName: string): HastNode[] {
  if (node.tagName === tagName) return [node];
  return (node.children ?? []).flatMap((child) => findAll(child, tagName));
}

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const plainText = (value: string) => value.replace(/\s+/gu, " ").trim();

const listContainers = new Set(["div", "ul", "ol", "section", "menu"]);
/**
 * A block that is almost only links, such as a language picker, table of
 * contents or site menu inside the main element; it would crowd the page's
 * text out of the 20,000 characters.
 */
function linkList(node: HastNode): boolean {
  if (!listContainers.has(node.tagName ?? "")) return false;
  let links = 0;
  let linkText = 0;
  const count = (item: HastNode) => {
    if (item.tagName === "a") {
      links++;
      linkText += plainText(textOf(item)).length;
      return;
    }
    item.children?.forEach(count);
  };
  count(node);
  const text = plainText(textOf(node)).length;
  return links >= 10 && text > 0 && linkText / text >= 0.8;
}

/**
 * Drops markup that is not page text and makes link targets absolute. Inside
 * code every element but scripts and styles keeps its text, since highlighters
 * wrap identifiers in buttons; a link without a usable target keeps its text.
 */
function prune(
  node: HastNode,
  dropChrome: boolean,
  pageURL: string,
  inCode = false,
): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): HastNode[] => {
    if (child.type === "comment" || child.type === "doctype") return [];
    if (child.type !== "element") return [child];
    const tag = child.tagName ?? "";
    const properties = child.properties ?? {};
    const code = inCode || tag === "pre" || tag === "code";
    if (
      (properties.hidden !== undefined && properties.hidden !== false) ||
      properties.ariaHidden === true ||
      properties.ariaHidden === "true" ||
      (dropChrome && chrome.has(tag)) ||
      (typeof properties.role === "string" &&
        droppedRoles.has(properties.role)) ||
      (alwaysDropped.has(tag) && (!code || codeDropped.has(tag))) ||
      (!code && linkList(child))
    )
      return [];
    if (tag === "table" && !code && layoutTable(child)) toBlocks(child);
    let unwrap = alwaysDropped.has(tag);
    for (const name of ["href", "src"] as const) {
      const value = properties[name];
      if (typeof value !== "string") continue;
      const absolute = resolve(value, pageURL);
      if (absolute) properties[name] = absolute;
      else if (tag === "img") return [];
      else unwrap = true;
    }
    prune(child, dropChrome, pageURL, code);
    // An icon link with nothing left to show is only noise.
    if (tag === "a" && !plainText(textOf(child)) && !find(child, "img"))
      return [];
    return unwrap ? (child.children ?? []) : [child];
  });
}

// A table holding another table lays the page out; Markdown cannot nest
// tables, so its cells become plain blocks.
const layoutTable = (table: HastNode) =>
  (table.children ?? []).some((child) => find(child, "table") !== undefined);
const tableParts = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);
function toBlocks(node: HastNode): void {
  node.tagName = "div";
  for (const child of node.children ?? [])
    if (child.tagName !== "table" && tableParts.has(child.tagName ?? ""))
      toBlocks(child);
}

function resolve(value: string, base: string): string | undefined {
  if (value.startsWith("#")) return undefined;
  try {
    const url = new URL(value, base);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
