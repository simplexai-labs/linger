// A Routine's schedule in a few words, the way the desktop's Routines list
// reads it: "Daily at 09:00", "Mon, Wed at 18:30", "Every 2 hours".
import type { Routine } from "../api/types";
import type { Translate } from "../i18n/language";
import type { Message } from "../i18n/messages";
import { chatRoutineCadenceMessages as m } from "./routine-cadence.messages";

type Cadence = NonNullable<Routine["cadence"]>;

const DAYS: Record<string, Message<string>> = {
  monday: m.monday,
  tuesday: m.tuesday,
  wednesday: m.wednesday,
  thursday: m.thursday,
  friday: m.friday,
  saturday: m.saturday,
  sunday: m.sunday,
};

function clock(cadence: Cadence): string {
  const hour = String(cadence.hour ?? 0).padStart(2, "0");
  const minute = String(cadence.minute ?? 0).padStart(2, "0");
  return `${hour}:${minute}`;
}

/** `t` is passed in so this module stays free of the device's language. */
export function describeCadence(
  cadence: Cadence | undefined,
  t: Translate,
): string {
  if (!cadence) return t(m.onEvent);
  switch (cadence.kind) {
    case "daily":
      return t(m.dailyAt, { time: clock(cadence) });
    case "weekly": {
      const days = (cadence.weekdays ?? []).map((day) => {
        const name = DAYS[day];
        return name ? t(name) : day;
      });
      return days.length > 0
        ? t(m.daysAt, {
            days: days.join(t(m.daySeparator)),
            time: clock(cadence),
          })
        : t(m.weeklyAt, { time: clock(cadence) });
    }
    case "every_n_hours":
      return t(m.everyHours, { count: cadence.interval_hours ?? 1 });
    case "every_n_minutes":
      return t(m.everyMinutes, { count: cadence.interval_minutes ?? 10 });
    case "once":
      return t(m.once);
    default:
      return t(m.scheduled);
  }
}
