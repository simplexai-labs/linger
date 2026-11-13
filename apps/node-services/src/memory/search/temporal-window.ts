// Temporal recall adapted from Hindsight (MIT, Copyright (c) 2025 Vectorize AI,
// Inc.; engine/memories/pg/recall.py): a time window is one more ranked branch
// that votes in fusion. It never filters other branches.

/** Candidates read inside the window before coverage selection. */
export const TEMPORAL_POOL_SIZE = 60;
/** Candidates the branch contributes to fusion. */
export const TEMPORAL_ENTRY_POINTS = 10;
const TEMPORAL_COVERAGE_BUCKETS = 8;

export interface TimeWindow {
  from?: string;
  to?: string;
}

/** Inclusive SQL bounds for an open-ended window. */
export function windowBounds(window: TimeWindow): { from: string; to: string } {
  return { from: window.from ?? "0001-01-01", to: window.to ?? "9999-12-31" };
}

/**
 * Spread entry points over the window: split it into equal time buckets and
 * take the best-ranked remaining item of each bucket in turn, so one busy
 * day cannot fill every slot. Rows arrive best-ranked first.
 */
export function selectWithTemporalCoverage<T>(
  rows: readonly T[],
  dateOf: (row: T) => string | undefined,
  window: TimeWindow,
  limit = TEMPORAL_ENTRY_POINTS,
): T[] {
  if (rows.length <= limit) return [...rows];
  const dates = rows
    .map((row) => Date.parse(dateOf(row) ?? ""))
    .filter(Number.isFinite);
  const start = Date.parse(window.from ?? "") || Math.min(...dates);
  const end = Date.parse(window.to ?? "") || Math.max(...dates);
  const span = Math.max(end - start, 1);
  const buckets: T[][] = Array.from(
    { length: TEMPORAL_COVERAGE_BUCKETS },
    () => [],
  );
  for (const row of rows) {
    const at = Date.parse(dateOf(row) ?? "");
    const index = Number.isFinite(at)
      ? Math.min(
          TEMPORAL_COVERAGE_BUCKETS - 1,
          Math.max(
            0,
            Math.floor(((at - start) / span) * TEMPORAL_COVERAGE_BUCKETS),
          ),
        )
      : 0;
    buckets[index]!.push(row);
  }
  const selected = new Set<T>();
  while (selected.size < limit && buckets.some((bucket) => bucket.length))
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next !== undefined && selected.size < limit) selected.add(next);
    }
  // Fusion uses rank, so keep the incoming order among the chosen rows.
  return rows.filter((row) => selected.has(row));
}

/** Relevant candidates an as-of route reorders by recency. */
export const AS_OF_RELEVANT = 20;
/**
 * An as-of route votes twice: it is asked only for a value that changes, and
 * its candidates are already the most relevant, so recency should decide
 * between them rather than tie with how often a stale mention repeats words.
 */
export const AS_OF_WEIGHT = 2;

/**
 * The value in effect on a day is its latest mention on or before it: of the
 * most relevant candidates (best-ranked first, all on or before the day), the
 * most recent come first, so the last thing said before then leads.
 */
export function selectLatestOnOrBefore<T>(
  rows: readonly T[],
  dateOf: (row: T) => string | undefined,
  limit = TEMPORAL_ENTRY_POINTS,
): T[] {
  return rows
    .slice(0, AS_OF_RELEVANT)
    .map((row, rank) => ({ row, rank, date: dateOf(row) ?? "" }))
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || left.rank - right.rank,
    )
    .slice(0, limit)
    .map(({ row }) => row);
}
