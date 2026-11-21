# Knowledge Format

Knowledge Format provides shared YAML-based parsing and serialization helpers for knowledge documents, reused by Memory, the Wiki and other knowledge code.

Root-index version updates address the YAML field, including quoted keys, flow
maps and multiline values. They retain other metadata values and the Markdown
body when setting `okf_version`.

The package has no AGENTS.md of its own; commands are the `scripts` in `package.json`, and general conventions are in the root [AGENTS.md](../../AGENTS.md).
