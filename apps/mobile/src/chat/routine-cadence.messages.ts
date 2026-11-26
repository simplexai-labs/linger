import { defineMessages } from "../i18n/messages";

export const chatRoutineCadenceMessages = defineMessages("chatRoutineCadence", {
  onEvent: "When something happens",
  dailyAt: "Daily at {time}",
  daysAt: "{days} at {time}",
  weeklyAt: "Weekly at {time}",
  everyHours: { one: "Every hour", other: "Every {count} hours" },
  everyMinutes: { one: "Every minute", other: "Every {count} minutes" },
  once: "Once",
  scheduled: "Scheduled",
  daySeparator: ", ",
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
});
