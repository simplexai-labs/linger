# Meetings and appointments

## Routines it usually needs

- **Preparation reminder**: about 30 minutes before (longer for something that needs travel), with what to bring or read.
- For an appointment that must be confirmed or booked in advance, one reminder when that should happen.
- **The evening before**, when the next day holds several meetings or people the Human meets for the first time: one look at the whole day.

## When to tell

- The evening before: who the Human meets, when and where, and what each meeting is about or what they want from it. Leave out routine meetings that need nothing.
- Before it starts: time, title or place, people, and what the Human needs to bring. When its Routine has a `Look up first:` line, add the points that turned up, with their source. Point out what does not add up between sources (a changed time, a figure that differs between the deck and the mail).
- The time, place or link changed, or it was cancelled: tell at once.
- It is on a later day and nothing changed: say nothing now.

## When things change

- Rescheduled: update the item's `due_at` and move its Routines.
- Cancelled, or its time has passed: mark the item done and delete remaining Routines. A reminder before the meeting does not finish it.

## Preparing

Worth preparing, so the meeting's Routine gets a `Look up first:` line:

- An interview, a podcast or press conversation, or a first meeting with someone: what the Human said before on the topics they will be asked about, and public background on the person or outlet from the web.
- A meeting with an investor, client or partner: where things were left last time and what they asked for or are waiting on. When there were earlier meetings with the same people, go through them in order: when each was, what was discussed, what moved forward, what is still open or promised, and what to raise this time.
- A meeting where the Human presents, pitches, demos or decides: the state of the materials, and the outside facts the meeting needs, such as the latest on the topic, the market or the other side's recent news. These come from the web; the Human's own mail and knowledge will not have them.

Where to look: the Human's knowledge, recordings and mail for history and promises; the web for anything outside the Human's own material. When a meeting needs both, the `Look up first:` line names both.

Write the line so it can be searched as written: the meeting's topics as their own search (what the Human said, decided or promised about them), and the people or organisation as another. A search for the names alone finds who they are, not what the Human knows about the topics the meeting is about.

What to make is your call:

- Little turned up, or little is known about the meeting: a few lines in the reminder.
- More than a few lines, which is usually the case for an investor, client or partner with history to review: a short prep document made with `teamhub docs create`, linked in the reminder. Keep the reminder short enough to take in at a glance; when the points would make it long, they go into the document and the reminder links it.
- The Human pitches or presents to this audience and has no deck for them: a deck of at most about ten pages on what this audience cares about, built by a Task (`teamhub task create`, using the pptx Skill) and linked in the reminder.

Remind and prepare unless the Human declined or the meeting was cancelled: many people never formally accept an invitation, so a missing reply is not a no. Never make an accepted invitation or a confirmed time a condition in the Routine's `--content`; it skips only when the Human declined or the meeting was cancelled. Set the Routine early enough to finish what you make; a deck usually needs the day before. Write only what you found, each point with where it came from; when nothing turned up, say so. Put the `Look up first:` line and what to make into the Routine's `--content` when you arrange it, since the Routine does not read this guide when it fires.

Not worth preparing: a recurring or internal meeting, an all-hands, or a personal appointment such as a doctor, a haircut or a repair visit. Its reminder says the time, the place or link, and what to bring.
