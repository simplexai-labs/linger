# Connector: the seam between a chat surface and a Room

A Connector moves messages between an external chat surface and TeamHub. It
owns transport and nothing else: it does not create Messages, does not choose
an author, and does not decide that a turn should run.

## Common Commands

- `pnpm --filter @linger/connector check`: typecheck, lint, and test the package.

## Structure

- `src/index.ts`: the `Connector` interface (`authenticate`,
  `describeCapabilities`, `poll`, `send`), the event and result types, and
  `createSeen` for de-duplicating surface re-delivery.
- `src/text.ts`: `splitForLimit`, which cuts text to a surface's limit between
  blocks and lines and keeps a fenced block balanced across the cut.
- `src/ilink.ts`: Tencent iLink as the reference implementation
  (`ILinkConnector`, `ILINK_CAPABILITIES`, `Transport`), with a `Transport` seam
  so tests never touch the network.

## Important Conventions

- A Connector reports what a surface can do in `Capabilities`. A sender reads
  that instead of hard-coding a surface's limits, so a new surface does not
  need every caller changed.
- A failed send is a `SendResult` with `delivered: false` and a `reason`, never
  a thrown error and never an optimistic `true`. The host keeps an undelivered
  item; the Connector does not retry on its own.
- Polling returns `[]` for a transport error or an empty window. A host loop
  must not need a `try` around `poll`.
- De-duplicate on the surface's message id, never on text: a person really does
  send the same short message twice.
- A Connector never holds a user's credential for their own account. It holds
  only what the surface issued to the bot identity.
