/**
 * Internal insertion slot placed between the cacheable static prefix and the
 * volatile per-Agent / per-Room / per-Task context sections. The Local
 * Computer Daemon resolver consumes and removes this marker while inserting
 * host guides before the dynamic tail, so it never reaches the model.
 */
export const STATIC_PREFIX_END_MARKER = "<!-- LINGER_STATIC_PREFIX_END -->";

export interface SplitInstructions {
  readonly static?: string;
  readonly dynamic?: string;
}
