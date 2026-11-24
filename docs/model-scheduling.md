# Model Scheduling

A model serves one more request only by slowing the others, and every agent,
approval and background job on a computer shares it. One queue per endpoint,
one runtime on one computer, decides what reaches the model: each unit of work
waits its turn by priority. Codex runs with its sub-agents turned off, because
their requests would reach the model beside the Run's own without waiting.

| Endpoint                                                       | Starts at | Grows to |
| -------------------------------------------------------------- | --------- | -------- |
| A runtime whose models go through a gateway or key             | 1         | 8        |
| A runtime whose every model is on your account                 | 10        | 10       |
| A computer that does not say how it reaches them               | 1         | 8        |
| A local library model probed as single-slot (`concurrency: 1`) | 1         | 1        |
| A local library model probed at `N >= 2`                       | `N`       | 8        |

When a Computer loads a local library model whose configured concurrency
exceeds one, its Daemon runs a one-time loopback concurrency probe before
reporting the model loaded (showing `"Probing max concurrency"` via
`concurrency_probing: true` while `state: "loading"`). Measured probe outcomes
(`1` or `2`) are cached by model, engine, placement, context length, configured
slots, and tool version, and override the raw slot count on the loaded model;
transient probe errors and timeouts are not cached, omit `concurrency` for
that load (falling back to `{ initial: 1, max: 8 }`), and retry on the next
load. Only Computers that negotiate `local_models_concurrency_probe` (`0.64.0`
or later) have their loaded `concurrency` applied by `ModelQueue`; older
Computers stay on `{ initial: 1, max: 8 }`. A verified `1` caps the endpoint at
`{ initial: 1, max: 1 }` without background probing, while a verified `N >= 2`
sets `{ initial: N, max: 8 }` so the queue starts immediately at `N` and still
allows adaptive background probing upward (and loading another local model does
not force an already-loaded model down to `1` or reset what was learned).

The number of units at once adapts to how the endpoint answers. Each request
counts at the number of units that actually ran while it was timed, not at
the limit. The confirmed limit grows only through silent background probes:
once single-unit background calls establish a baseline and no foreground,
Task, Document or compaction work is active or waiting, the queue temporarily
runs one more yieldable background call at once (on Computers that can stop a
model call). If those concurrent background calls stay within 1.3x of the
lone-unit speed, the confirmed limit promotes by one; if a probe sample slows
past 1.8x, the probe median exceeds 1.3x, or the endpoint refuses work, the
probe stops immediately and the confirmed limit stays unchanged. If higher
work arrives during a probe, the probe aborts at once and swaps out the extra
background calls so interactive work never pays for an unconfirmed limit. In
steady state, when requests at the confirmed limit get clearly slower (past
1.8x) it gives one back, and when the endpoint refuses work (rate limited,
overloaded, or a call runs out of time) it halves and holds off probing for a
minute. Speed is compared per
thousand new prompt tokens, so a long prompt does not look like a busy
endpoint. A number that failed a probe or had to be given back is not probed
again for five minutes; if that retry fails as well, the wait doubles, up to
half an hour. What it learns lasts until the service restarts or the runtime's
models change.

The current adaptive limit is the hard limit. Ordinary work can start while
the total running count is below the soft limit, `max(1, hard - 1)`.
Recording questions and notes, chat, the rest of a Room conversation's work
and standalone approvals can use the last place. When the limit drops, new
work respects the lower limit. A Computer with an explicit Operation capacity
also reserves its last place for an interactive Run when that capacity
exceeds one.

| Work in priority order        | Unit                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tool approval                 | The review borrows the reviewed Run's place on the same endpoint. A standalone review queues first.        |
| Recording questions and notes | A question in a recording's Ask tab, and the quick notes written when a recording ends.                    |
| Chat                          | A Human's message, a Human's answer to a card, and a request sent to the Agent from a recording's Ask tab. |
| Conversation work             | Task callbacks, agent messages, automatic follow-ups, routines and proactive Runs share one priority.      |
| Tasks and documents           | Task and document Runs share one priority.                                                                 |
| Compaction                    | An idle conversation's session compaction. New work for that conversation cancels it.                      |
| Background                    | Agent memory, user memory, profile, insights and wiki refresh, in descending priority.                     |

When conversation work or anything before it is first in line and cannot
start, it swaps out the lowest-priority work below it on that endpoint, one
unit at a time and at any limit. A background model call goes first: the
Computer stops the call, the waiting work starts once the Computer confirms
the stop, and the call queues again at its priority to run the same attempt
later, without counting it as a failed try. A Computer before release 0.53.0
cannot stop one call, so there the waiting work waits for it. Otherwise the
work asks the lowest-priority running Run below it on that endpoint or
Computer to yield. A recording question can swap out a chat, a chat can swap
out a routine, and any conversation Run can swap out a Task. Routines and
proactive Runs rank above Tasks on purpose: a routine that comes due or a
reminder the user asked for runs on time instead of waiting for a long Task,
and the Task gives up its current turn for it. Work of one
priority never swaps out its own kind. A Run can yield once the Runtime has a
resumable native session and the Run has produced model output, its thinking
included, or a tool event since it last started or resumed. Its original input
is then in its history, and every resume makes some progress before the Run
can be swapped out again. A pending tool approval or human interaction is
answered before yielding. The waiting work starts after the Computer confirms
cleanup. A Run that finishes on its own while it is asked to yield completes
normally. The yielded Run keeps its ID, running status and claim while it
waits, and continues in the same session when admitted again. A user stop
still ends it. A yield the Computer has not finished after 90 seconds no
longer blocks other swaps: the Agent Service logs it, does not ask that Run
again, and lets the waiting work ask the next Run below it. A Task the user
stopped keeps its place until its Computer confirms the stop, so a chat
cannot start beside it, but for at most the cancel timeout plus 45 seconds;
then the Agent Service ends it, logs the unconfirmed stop and frees the place.
If a yielded Run's cleanup cannot be confirmed, the Computer refuses further
work on that Runtime until it restarts. Other stops only report the unknown
cleanup. A recording question, its notes, an approval and a compaction are
never interrupted, so waiting work may still wait for one of them.

Each running Operation holds one place across its tool calls. Within a Room
conversation, a chat does not wait behind non-chat work of that conversation.
If a non-chat Run has not yet been sent to its Runtime — before claim, waiting
for a place, or waiting to resume after a yield — the waiting Run returns to
the queue and the chat is claimed first. If the Run has already reached its
Runtime, the chat steers into it from any of the Room's Inboxes and raises the
Run's priority to chat, so it can swap out lower work ahead of it. The priority
never drops while the Run lives. Task and document Runs keep theirs. Eligible
work at the same priority starts in arrival order. When interactive work has
waited 30 seconds for a place, the Agent Service log names the Runs holding
places and why none of them can yield.

Wiki and Memory chains keep their steps in order on one endpoint. Each model
attempt releases its place when the Runtime answers or the step is swapped
out. A waiting chat can start before the next step, retry or correction, even
at a hard limit of one. The chain then continues with the results of its
completed steps.

Time limits count running time. A model call's timeout starts when the
Runtime starts the attempt, so waiting for a place, also while other work was
swapped in, does not count. A recording question or its notes may therefore
wait for a place up to the five minutes TeamHub keeps any model call open. A
Wiki refresh's 150-minute budget counts only the time at least one of its
model attempts holds a place. Because TeamHub waits at most four hours for the
whole refresh, a refresh also starts no new step after three and a half hours
and publishes what it has accepted.

Every model call is retried and corrected in one place. A timeout, a reply past
its length cap or a runtime failure is tried again after a pause, and an answer
that does not fit its schema or its caller's checks is sent back with the
reason. How many tries a call gets depends on its kind.

<sub>The queue only admits work; within a Room conversation, a chat may join
the reply in progress or go ahead of queued non-chat work, while chats keep
their order.</sub>
