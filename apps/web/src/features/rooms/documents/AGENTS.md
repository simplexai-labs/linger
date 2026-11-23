# Room Document Web Boundary

- This directory owns the Room Product Client's Room Document editor surface,
  browser collaboration session, IndexedDB persistence, and user-visible
  save-state projection.
- TeamHub's public HTTP contract is the only source for Document metadata and
  collaboration credentials. A credential is a signed connection token, opaque
  to the browser; every reconnect asks TeamHub for a new one, because any
  permission change makes earlier tokens stale. The browser must not call
  TeamHub internal Document State operations or hold service credentials.
- Document Runtime owns Yjs WebSocket sync and awareness. Browser state is a
  recoverable local copy, never a second authority for permissions, durable
  sequence, publication, comments, assets, or lifecycle.
- `Saved` requires both local and remote hydration, an authenticated durable
  ACK, exact durable vector equality, and a newer durable sequence after any
  hydrated state change. Hocuspocus sync alone is never presented as durable
  save evidence. Full-state hashes remain server-side integrity evidence and
  must not be compared across independent browser and Runtime Y.Doc replicas.
- Keep protocol and persistence lifecycle behind the collaboration-session
  interface. React components render that interface and must not parse durable
  ACK envelopes or construct IndexedDB keys themselves.
- Only an editing session keeps a local copy, one per Actor and Document; a
  reopened session saves it under its new token. `room-document-local-copies.ts`
  owns copy names and deletion: a Document's copies go when TeamHub denies
  access to it, and an account's copies go at logout. Close this tab's sessions on a copy before
  deleting it, and close on `versionchange` so other tabs never block a
  deletion. It stays free of editor dependencies because logout imports it.
- Test state invariants through the collaboration-session interface and test
  the real browser workflow with Playwright. Do not inspect provider or
  IndexedDB internals from component tests.
- Gmail, Outlook and Feishu Mail canvases use the Mail sidebar header, an editable 15px semibold Subject above
  the From/To/Cc fields and collaborative body, without the generic Document title or
  author row. The header reads Drafting while an edit is not durable yet,
  Saved once it is, and Sent once delivered; connection and save problems
  keep the shared save indicator. Formatting uses the existing editor
  controls. Attachments (15 MiB total) upload through the existing Document
  Asset flow from a dashed + tile below the body; file blocks stay
  authoritative and show as tiles with sizes and remove controls. Canvas has no
  sending toolbar; the email's chat card sends it, and once its delivery
  reports sent the editor writes `status: sent` into the header. Sent canvases stay read-only, suppress the editing indicator, and show
  empty recipient fields as None. Attachment list spacing stays inside the
  measured height so its resize animation cannot clip the last file.
