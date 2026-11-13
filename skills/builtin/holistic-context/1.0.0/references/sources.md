# Sources

Each source: what it answers, how reliable and how current it is, and the command.

| Source | Answers | Reliability and freshness | Command |
|---|---|---|---|
| memory.md (in your instructions when present) | who the Human is, stable preferences, working style | approved, short; may lack details | none |
| this conversation | what the Human just said | newest | none |
| knowledge search | past conversations, recordings, imported mail, documents, Pocket Notes, Profile, Wiki pages, Daily/Weekly reports, facts | original sources are the record; Wiki and reports summarize and can be stale; mail stops at the last import | `teamhub knowledge search` / `read` |
| calendar | meetings and events, free time | authoritative for time; current | `teamhub gcal list` / `free` / `read` |
| Tracking Items | open commitments, things waiting on others, deadlines, upcoming meetings and plans | current state of what is still open | `teamhub tracking-items list` |
| Routines | reminders and checks already scheduled in this Room | this Room only | `teamhub routine list` |
| Slack | latest team discussion and progress | current | `teamhub slack search` / `read` |
| Drive, Notion, GitHub | documents, specs, code and issues | current | `teamhub gdrive`, `teamhub notion`, `teamhub github`: `search` / `read` |
| live mail | mail after the last import | current | `teamhub gmail list` / `read`, `teamhub outlook list` / `read` |
| web | prices, availability, schedules, public facts | check now, never from memory | the Runtime's web search and fetch tools |
| lev8 | people and companies outside the Human's records | external, may be dated | the lev8-search Skill, when available |

Connected app commands work only for apps the Human has connected; `teamhub apps list` shows which.
