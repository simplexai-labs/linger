// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDesktopLocalAccountSignedOut,
  DESKTOP_LOCAL_RECOVERY_COOLDOWN_MS,
  isDesktopLocalAccountSignedOut,
  markDesktopLocalAccountSignedOut,
  resetDesktopLocalSignInStateForTest,
  trySilentDesktopLocalSignIn,
  type DesktopLocalAccount,
} from "./desktop-local-account";

function setDesktopLocalAccount(account?: DesktopLocalAccount) {
  (
    window as { lingerDesktop?: { localAccount?: DesktopLocalAccount } }
  ).lingerDesktop = account ? { localAccount: account } : undefined;
}

beforeEach(() => {
  resetDesktopLocalSignInStateForTest();
  setDesktopLocalAccount(undefined);
});

afterEach(() => {
  resetDesktopLocalSignInStateForTest();
  setDesktopLocalAccount(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop local account silent recovery", () => {
  it("returns false when the desktop bridge is absent", async () => {
    expect(await trySilentDesktopLocalSignIn()).toBe(false);
  });

  it("signs in silently when the desktop local account is available", async () => {
    const account: DesktopLocalAccount = {
      available: vi.fn(async () => true),
      signIn: vi.fn(async () => ({ ok: true as const })),
    };
    setDesktopLocalAccount(account);

    expect(await trySilentDesktopLocalSignIn()).toBe(true);
    expect(account.available).toHaveBeenCalledOnce();
    expect(account.signIn).toHaveBeenCalledOnce();
  });

  it("suppresses silent sign-in after explicit logout until cleared", async () => {
    const account: DesktopLocalAccount = {
      available: vi.fn(async () => true),
      signIn: vi.fn(async () => ({ ok: true as const })),
    };
    setDesktopLocalAccount(account);

    markDesktopLocalAccountSignedOut();
    expect(isDesktopLocalAccountSignedOut()).toBe(true);
    expect(await trySilentDesktopLocalSignIn()).toBe(false);
    expect(account.available).not.toHaveBeenCalled();
    expect(account.signIn).not.toHaveBeenCalled();

    clearDesktopLocalAccountSignedOut();
    expect(isDesktopLocalAccountSignedOut()).toBe(false);
    expect(await trySilentDesktopLocalSignIn()).toBe(true);
    expect(account.signIn).toHaveBeenCalledOnce();
  });

  it("enforces a 30s cooldown after a failed attempt", async () => {
    vi.useFakeTimers();
    const account: DesktopLocalAccount = {
      available: vi.fn(async () => true),
      signIn: vi.fn(async () => ({
        ok: false as const,
        message: "server unavailable",
      })),
    };
    setDesktopLocalAccount(account);

    expect(await trySilentDesktopLocalSignIn()).toBe(false);
    expect(account.signIn).toHaveBeenCalledTimes(1);

    // Within cooldown: does not retry.
    await vi.advanceTimersByTimeAsync(DESKTOP_LOCAL_RECOVERY_COOLDOWN_MS - 1);
    expect(await trySilentDesktopLocalSignIn()).toBe(false);
    expect(account.signIn).toHaveBeenCalledTimes(1);

    // After cooldown: retries.
    await vi.advanceTimersByTimeAsync(1);
    expect(await trySilentDesktopLocalSignIn()).toBe(false);
    expect(account.signIn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent recovery attempts", async () => {
    let resolveSignIn!: (value: { readonly ok: true }) => void;
    const account: DesktopLocalAccount = {
      available: vi.fn(async () => true),
      signIn: vi.fn(
        () =>
          new Promise<{ readonly ok: true }>((resolve) => {
            resolveSignIn = resolve;
          }),
      ),
    };
    setDesktopLocalAccount(account);

    const first = trySilentDesktopLocalSignIn();
    const second = trySilentDesktopLocalSignIn();
    await vi.waitFor(() => expect(account.signIn).toHaveBeenCalledOnce());
    resolveSignIn({ ok: true });

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(account.available).toHaveBeenCalledOnce();
    expect(account.signIn).toHaveBeenCalledOnce();
  });

  it("aborts before signIn if explicit logout happens while available() is in flight", async () => {
    let resolveAvailable!: (value: boolean) => void;
    const account: DesktopLocalAccount = {
      available: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAvailable = resolve;
          }),
      ),
      signIn: vi.fn(async () => ({ ok: true as const })),
    };
    setDesktopLocalAccount(account);

    const pending = trySilentDesktopLocalSignIn();
    await vi.waitFor(() => expect(account.available).toHaveBeenCalledOnce());
    markDesktopLocalAccountSignedOut();
    resolveAvailable(true);

    expect(await pending).toBe(false);
    expect(account.signIn).not.toHaveBeenCalled();
  });

  it("returns false if explicit logout happens while signIn() is in flight", async () => {
    let resolveSignIn!: (value: { readonly ok: true }) => void;
    const account: DesktopLocalAccount = {
      available: vi.fn(async () => true),
      signIn: vi.fn(
        () =>
          new Promise<{ readonly ok: true }>((resolve) => {
            resolveSignIn = resolve;
          }),
      ),
    };
    setDesktopLocalAccount(account);

    const pending = trySilentDesktopLocalSignIn();
    await vi.waitFor(() => expect(account.signIn).toHaveBeenCalledOnce());
    markDesktopLocalAccountSignedOut();
    resolveSignIn({ ok: true });

    expect(await pending).toBe(false);
  });
});
