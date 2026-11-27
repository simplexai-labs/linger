// Counters for where the phone spends its time: durations by name, the last
// 100 of each, kept in memory only. They carry no message text, keys or
// payloads, and nothing leaves the phone; Settings shows them on request.
const LIMIT = 100;
const samples = new Map<string, number[]>();

export function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function record(name: string, ms: number): void {
  const list = samples.get(name) ?? [];
  list.push(ms);
  if (list.length > LIMIT) list.shift();
  samples.set(name, list);
}

/** Times `run` under `name`, returning its result. */
export function timed<T>(name: string, run: () => T): T {
  const started = now();
  try {
    return run();
  } finally {
    record(name, now() - started);
  }
}

export interface TimingSummary {
  readonly name: string;
  readonly count: number;
  readonly p50: number;
  readonly p90: number;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export function timingSummary(): TimingSummary[] {
  return [...samples.entries()]
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return {
        name,
        count: list.length,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function clearTiming(): void {
  samples.clear();
}
