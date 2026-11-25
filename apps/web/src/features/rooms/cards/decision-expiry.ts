import { useEffect, useState } from "react";

import type { Translate } from "@/i18n/language";

import { cardsMessages } from "./cards.messages";

/** Show a live countdown once an active decision is within 5 minutes of expiry. */
const COUNTDOWN_THRESHOLD_MS = 5 * 60_000;
/** Maximum 32-bit signed delay accepted by browser setTimeout. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Tracks the current clock for a decision card with an `expires_at` deadline.
 * Stays idle when inactive or far from expiry, wakes at the countdown threshold,
 * ticks every second while close to expiring, and stops once expired.
 */
export function useDecisionExpiryClock(
  expiresAt: string | undefined,
  active: boolean,
): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active || !expiresAt) return;
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return;

    let timer: number | null = null;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timer = window.setTimeout(() => {
          setNow(Date.now());
        }, 0);
        return;
      }
      const delay =
        remaining > COUNTDOWN_THRESHOLD_MS
          ? Math.min(remaining - COUNTDOWN_THRESHOLD_MS, MAX_TIMEOUT_MS)
          : Math.min(remaining, 1_000);
      timer = window.setTimeout(() => {
        const current = Date.now();
        setNow(current);
        if (current < deadline) {
          schedule();
        }
      }, delay);
    };

    schedule();
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [active, expiresAt]);

  return now;
}

/**
 * Formats the remaining time before expiry once within the countdown window;
 * returns null when no deadline is set, already expired, or still far away.
 */
export function formatExpiryCountdown(
  expiresAt: string | undefined,
  now: number,
  t: Translate,
): string | null {
  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return null;
  const remainingMs = deadline - now;
  if (remainingMs <= 0 || remainingMs > COUNTDOWN_THRESHOLD_MS) return null;
  const totalSeconds = Math.ceil(remainingMs / 1_000);
  if (totalSeconds < 60) {
    return t(cardsMessages.expiresInSeconds, {
      seconds: String(totalSeconds),
    });
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return t(cardsMessages.expiresInMinutes, {
      minutes: String(minutes),
    });
  }
  return t(cardsMessages.expiresInMinutesSeconds, {
    minutes: String(minutes),
    seconds: String(seconds),
  });
}
