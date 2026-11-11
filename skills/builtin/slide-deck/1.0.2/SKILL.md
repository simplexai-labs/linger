---
name: slide-deck
description: Plan a new slide deck, PPT, presentation or pitch from the Meta chat and delegate the build. Use it whenever the Human asks for a new deck or a rebuilt one, before delegating anything; agree the audience, style and length, tell the Human, then delegate to a Task that plans, finds the material and builds with the pptx skill. Not for Tasks, and not for small edits to an existing deck.
---

# Slide deck

A deck is good when it fits its audience and argues one clear story. This skill
is for the Meta: agreeing the deck with the Human and delegating it. The Task
does everything else with the `pptx` skill: it writes the brief and storyline,
finds and reads the Human's existing material, researches the web and builds.

## Meta (Room or personal chat)

Do these steps before `teamhub task create`. Do not delegate first and plan
later. Keep your turn short; do not search the workspace or the web for
material yourself. Speak in the Human's language.

1. **Small edit?** If the Human only wants to change an existing deck (a
   title, a number, one slide), skip this flow and delegate the edit with the
   `pptx` skill.
2. **Ask only what is missing.** Check the request and this conversation for
   three things: audience, style and number of slides. If any are missing,
   send one `teamhub message ask-user` card with only those questions, in that
   order, each with options, and end your turn. For style, propose 2–3 named
   professional looks that fit this topic and audience (e.g. "McKinsey blue:
   navy and white, action titles, dense exhibits"), each with a few words on
   palette and feel.
   Ask whenever any of the three is missing, however brief or hurried the
   request; skip the card only when all three are given. Never ask whether to
   start or for material; the answers are the go-ahead.
3. **Tell the Human what you settled** (audience, style, number of slides)
   with `teamhub message send` and delegate in the same turn; they can still
   correct it.
4. **Delegate** with `teamhub task create --name "Deck: <topic>"
   --requirement "<requirement>"`. In a few lines, give the Human's request in
   their words, the audience, style and number of slides, and end with "Build
   it with the pptx skill." The Task cannot read this chat: quote everything
   from the conversation it needs (facts, names of projects, documents or files
   the Human mentioned, things to avoid), and refer to skills by name, never by
   local path.
5. **Deliver** when the Task reports: open the PPTX in `./playground/<task-id>/`,
   look at its rendered slides if the Task left them, and send one
   `teamhub message send` with the file attached (`--attach`): a one-line
   result, then one sentence naming what the Human should add or check (the
   missing facts are marked in the deck).
   Send fixes, feedback and those answers to the same Task with
   `teamhub task send`.

## In a Task

This skill is not for Tasks. Build with the `pptx` skill and follow its
workflow.
