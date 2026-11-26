// How long a copied secret may stay on the clipboard.
export const CLIPBOARD_CLEAR_MS = 60_000;

export interface SecretClipboardTarget {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  clear(): void;
}

/**
 * Writes a secret to the clipboard and clears it after `clearAfterMs` only if
 * the clipboard still holds that exact value. Re-copying resets the timer.
 */
export class SecretClipboard {
  readonly #clipboard: SecretClipboardTarget;
  readonly #clearAfterMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    clipboard: SecretClipboardTarget,
    clearAfterMs = CLIPBOARD_CLEAR_MS,
  ) {
    this.#clipboard = clipboard;
    this.#clearAfterMs = clearAfterMs;
  }

  async copy(secret: string): Promise<number> {
    await this.#clipboard.writeText(secret);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // Something copied since is left alone.
      void this.#clipboard
        .readText()
        .then((current) => {
          if (current === secret) this.#clipboard.clear();
        })
        .catch(() => undefined);
    }, this.#clearAfterMs);
    this.#timer.unref?.();
    return this.#clearAfterMs;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
