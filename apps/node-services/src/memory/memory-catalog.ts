import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./fs-utils.js";
import { parseMemoryMarkdown, stringValue } from "./markdown.js";
import { agentMemoryRoot, agentWorkspaceRoot } from "./paths.js";

/** The token `markMemoryChanged` writes after a batch of Memory writes. */
const MEMORY_REVISION_FILE = "memory.revision";
const defaultLimit = 50;
const maximumCatalogs = 32;
/** Metadata may lag an external edit this long when nothing bumped the revision. */
const defaultMaxStalenessMs = 5_000;

export type MemoryEntryKind = "daily" | "weekly";

export interface MemoryCatalogFile {
  readonly id: string;
  readonly kind: MemoryEntryKind;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly title: string;
  readonly summary: string;
  readonly updatedAt: string;
  readonly date?: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface MemoryCatalogPage {
  readonly items: readonly MemoryCatalogFile[];
  readonly nextCursor?: string;
}

interface CatalogOptions {
  readonly root: string;
  readonly workspaceRoot: string;
  /** The subject key the published entry IDs hash with. */
  readonly agentId: string;
  readonly readFile?: typeof fs.readFile;
  readonly stat?: typeof fs.stat;
  readonly walk?: (root: string) => AsyncIterable<string>;
  readonly now?: () => number;
  readonly maxStalenessMs?: number;
}

/**
 * The metadata of one Agent's daily and weekly Memory pages, kept between
 * requests. A page is re-read only when its size or modification time changed,
 * and the whole tree is walked only when `memory.revision` changed or the
 * cached metadata is older than `maxStalenessMs`.
 */
export class MemoryCatalog {
  readonly #root: string;
  readonly #workspaceRoot: string;
  readonly #agentId: string;
  readonly #readFile: typeof fs.readFile;
  readonly #stat: typeof fs.stat;
  readonly #walk: (root: string) => AsyncIterable<string>;
  readonly #now: () => number;
  readonly #maxStalenessMs: number;
  readonly #entries = new Map<string, MemoryCatalogFile>();
  readonly #byId = new Map<string, MemoryCatalogFile>();
  #sorted: readonly MemoryCatalogFile[] | undefined;
  #revision: string | undefined;
  #refreshedAt = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<void> | undefined;

  constructor(options: CatalogOptions) {
    this.#root = options.root;
    this.#workspaceRoot = options.workspaceRoot;
    this.#agentId = options.agentId;
    this.#readFile = options.readFile ?? fs.readFile;
    this.#stat = options.stat ?? fs.stat;
    this.#walk = options.walk ?? walkFiles;
    this.#now = options.now ?? Date.now;
    this.#maxStalenessMs = options.maxStalenessMs ?? defaultMaxStalenessMs;
  }

  async list(input: {
    kind?: string;
    cursor?: string;
    limit?: number;
  }): Promise<MemoryCatalogPage> {
    await this.#refresh();
    const files = input.kind
      ? this.#snapshot().filter((file) => file.kind === input.kind)
      : this.#snapshot();
    const start = cursorStart(files, input.cursor);
    const limit = input.limit ?? defaultLimit;
    const page = files.slice(start, start + limit);
    const next = start + page.length;
    return {
      items: page,
      ...(next < files.length ? { nextCursor: encodeCursor(page.at(-1)) } : {}),
    };
  }

  /** The entry of `id`, refreshing once more when the cached tree misses it. */
  async get(id: string): Promise<MemoryCatalogFile | undefined> {
    await this.#refresh();
    const cached = this.#byId.get(id);
    if (cached) return cached;
    // A write that skipped `markMemoryChanged` must not hide a new page.
    await this.#rescan(await this.#readRevision());
    return this.#byId.get(id);
  }

  async read(file: MemoryCatalogFile): Promise<string> {
    return await this.#readFile(file.absolutePath, "utf8");
  }

  #snapshot(): readonly MemoryCatalogFile[] {
    return this.#sorted ?? [];
  }

  async #refresh(): Promise<void> {
    if (this.#refreshing) return await this.#refreshing;
    const revision = await this.#readRevision();
    const unchanged =
      revision !== undefined &&
      revision === this.#revision &&
      this.#sorted !== undefined;
    if (unchanged && this.#now() - this.#refreshedAt < this.#maxStalenessMs) {
      return;
    }
    await this.#rescan(revision);
  }

  /** One scan at a time, whether a read missed or the revision changed. */
  async #rescan(revision: string | undefined): Promise<void> {
    if (this.#refreshing) return await this.#refreshing;
    this.#refreshing = this.#scan(revision).finally(() => {
      this.#refreshing = undefined;
    });
    return await this.#refreshing;
  }

  async #scan(revision: string | undefined): Promise<void> {
    const seen = new Set<string>();
    for (const directory of ["timeline/daily", "timeline/weekly"]) {
      for await (const absolutePath of this.#walk(
        path.join(this.#root, directory),
      )) {
        const relativePath = path
          .relative(this.#root, absolutePath)
          .split(path.sep)
          .join("/");
        const kind = classifyPath(relativePath);
        if (!kind) continue;
        seen.add(relativePath);
        let metadata: Awaited<ReturnType<typeof fs.stat>>;
        try {
          metadata = await this.#stat(absolutePath);
        } catch (error) {
          // A page removed between the walk and the stat is simply absent.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const cached = this.#entries.get(relativePath);
        if (
          cached &&
          cached.size === metadata.size &&
          cached.mtimeMs === metadata.mtimeMs
        ) {
          continue;
        }
        let content: string;
        try {
          content = await this.#readFile(absolutePath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const parsed = parseMemoryMarkdown(content);
        const date =
          metadataDate(parsed.metadata.date) ?? pathDate(relativePath);
        this.#entries.set(relativePath, {
          id: entryId(this.#agentId, relativePath),
          kind,
          relativePath,
          absolutePath,
          title: parsed.title,
          summary: parsed.summary,
          updatedAt: metadata.mtime.toISOString(),
          ...(date ? { date } : {}),
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      }
    }
    for (const relativePath of this.#entries.keys())
      if (!seen.has(relativePath)) this.#entries.delete(relativePath);
    this.#byId.clear();
    for (const entry of this.#entries.values()) this.#byId.set(entry.id, entry);
    this.#sorted = [...this.#entries.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.relativePath.localeCompare(right.relativePath),
    );
    this.#revision = revision;
    this.#refreshedAt = this.#now();
  }

  async #readRevision(): Promise<string | undefined> {
    try {
      return (
        await this.#readFile(
          path.join(this.#workspaceRoot, MEMORY_REVISION_FILE),
          "utf8",
        )
      ).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

const catalogs = new Map<string, MemoryCatalog>();

/** The catalog of one Agent, evicting the least recently used one past the cap. */
export function memoryCatalogFor(
  dataRoot: string,
  agentId: string,
): MemoryCatalog {
  const workspaceRoot = agentWorkspaceRoot(dataRoot, agentId);
  const cached = catalogs.get(workspaceRoot);
  if (cached) {
    catalogs.delete(workspaceRoot);
    catalogs.set(workspaceRoot, cached);
    return cached;
  }
  const catalog = new MemoryCatalog({
    agentId,
    root: agentMemoryRoot(dataRoot, agentId),
    workspaceRoot,
  });
  catalogs.set(workspaceRoot, catalog);
  for (const key of catalogs.keys()) {
    if (catalogs.size <= maximumCatalogs) break;
    catalogs.delete(key);
  }
  return catalog;
}

/** Drops every catalog; tests use it between cases. */
export function resetMemoryCatalogs(): void {
  catalogs.clear();
}

/** A stable page cursor: the sort key of the last item already read. */
export function encodeCursor(file: MemoryCatalogFile | undefined): string {
  if (!file) throw new TypeError("Memory cursor needs a page item");
  return Buffer.from(
    JSON.stringify({ p: file.relativePath, u: file.updatedAt }),
    "utf8",
  ).toString("base64url");
}

/** The index of the first item after `cursor`, or 0 without one. */
export function cursorStart(
  files: readonly MemoryCatalogFile[],
  cursor: string | undefined,
): number {
  if (!cursor) return 0;
  // Older servers paged by array offset; keep answering their cursors.
  if (/^[0-9]{1,9}$/u.test(cursor))
    return Math.min(Number(cursor), files.length);
  let key: { p?: unknown; u?: unknown };
  try {
    key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      p?: unknown;
      u?: unknown;
    };
  } catch {
    throw new TypeError("Memory cursor is invalid");
  }
  if (typeof key.p !== "string" || typeof key.u !== "string")
    throw new TypeError("Memory cursor is invalid");
  const index = files.findIndex(
    (file) =>
      file.updatedAt < key.u! ||
      (file.updatedAt === key.u && file.relativePath > key.p!),
  );
  return index === -1 ? files.length : index;
}

function classifyPath(relativePath: string): MemoryEntryKind | undefined {
  if (
    !relativePath.endsWith(".md") ||
    path.posix.basename(relativePath) === "index.md"
  )
    return undefined;
  if (/^timeline\/daily\/[^/]+\.md$/u.test(relativePath)) return "daily";
  if (/^timeline\/weekly\/[^/]+\.md$/u.test(relativePath)) return "weekly";
  return undefined;
}

function entryId(agentId: string, relativePath: string): string {
  return `memory_${crypto
    .createHash("sha256")
    .update(`${agentId}\0${relativePath}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function metadataDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return value.toISOString().slice(0, 10);
  const string = stringValue(value);
  return string && /^\d{4}-\d{2}-\d{2}$/u.test(string) ? string : undefined;
}

function pathDate(relativePath: string): string | undefined {
  const match = relativePath.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.md)?$/u);
  return match?.[1];
}
