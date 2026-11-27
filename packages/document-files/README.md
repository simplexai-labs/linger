# Document Files

Document Files holds shared helpers for Room Document files: media type detection and Markdown processing built on unified/remark.

Markdown image references use the first matching definition in document order, including definitions inside lists and block quotes. Preparing or extracting images removes unused data-URI definitions from those containers while retaining definitions still used by ordinary links. `extractDocumentImages` writes percent-encoded relative filenames into Markdown image URLs while keeping literal filenames in `files`, and `bundleDocumentImages` skips `#` fragments, rejects unencoded `?`/`#` or malformed percent-encoding, and validates decoded paths inside the playground.

There is one table from extension to representation format and media type, in the `@linger/document-files/media-type` subpath, which has no Node dependency. The CLI, Agent tools and Web all read it; Web keeps its own preview allowlist and file categories. `.m4v` is recorded as `video/mp4`. TeamHub's Go code does not use this table, so `agentsendmessage/atomic.go` and the inline playback allowlist must stay consistent with it.

The package has no AGENTS.md of its own; commands are the `scripts` in `package.json`, and general conventions are in the root [AGENTS.md](../../AGENTS.md).
