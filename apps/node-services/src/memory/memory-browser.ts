import type { components } from "@linger/wire-contracts/node-services-internal/types";

import { loadWikiGraphSubjectsForActor } from "./collector.js";
import { memoryCatalogFor, type MemoryCatalogFile } from "./memory-catalog.js";
import { browseMeetings } from "./meeting-browser.js";

const maxContentChars = 200_000;

type MemoryEntry = components["schemas"]["MemoryEntry"];
type MemoryEntryPage = components["schemas"]["MemoryEntryPage"];

export class MemoryBrowserNotFoundError extends Error {}

interface BrowserRequest {
  tenantId: string;
  ownerActorId: string;
}

export async function listMemoryEntries(input: {
  dataRoot: string;
  tenantId: string;
  ownerActorId: string;
  kind?: string;
  cursor?: string;
  limit?: number;
}): Promise<MemoryEntryPage> {
  if (input.kind === "meeting") return browseMeetings(input);
  const subject = await resolveSubject(input);
  const page = await memoryCatalogFor(
    input.dataRoot,
    subject.agentManagementId,
  ).list({
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return {
    items: page.items.map((file) => ({
      ...toEntry(file, ""),
      content: "",
    })),
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
  };
}

export async function getMemoryEntry(input: {
  dataRoot: string;
  tenantId: string;
  ownerActorId: string;
  entryId: string;
}): Promise<MemoryEntry> {
  if (input.entryId.startsWith("meeting_")) {
    const meeting = (await browseMeetings(input)).items[0];
    if (!meeting) throw new MemoryBrowserNotFoundError("Meeting was not found");
    return meeting;
  }
  const subject = await resolveSubject(input);
  const catalog = memoryCatalogFor(input.dataRoot, subject.agentManagementId);
  const file = await catalog.get(input.entryId);
  if (!file) throw new MemoryBrowserNotFoundError("Memory entry was not found");
  let content: string;
  try {
    content = await catalog.read(file);
  } catch (error) {
    // A page deleted outside the service inside the metadata window.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new MemoryBrowserNotFoundError("Memory entry was not found");
    throw error;
  }
  return toEntry(file, content.slice(0, maxContentChars));
}

async function resolveSubject(input: BrowserRequest) {
  const subjects = await loadWikiGraphSubjectsForActor(input.ownerActorId);
  const subject = subjects.find(
    (candidate) => candidate.tenantId === input.tenantId,
  );
  if (!subject) {
    throw new MemoryBrowserNotFoundError("Memory subject was not found");
  }
  return subject;
}

function toEntry(file: MemoryCatalogFile, content: string): MemoryEntry {
  return {
    content,
    id: file.id,
    kind: file.kind,
    path: file.relativePath,
    title: file.title,
    summary: file.summary,
    updated_at: file.updatedAt,
    ...(file.date ? { date: file.date } : {}),
  };
}
