# Process Contracts

This directory owns authoritative cross-process OpenAPI and the generated Go
and TypeScript modules consumed directly by Web, Agent, and TeamHub. It owns no
product policy or application behavior.

## Layout

```text
openapi/
  components/
  paths/
  teamhub-public/
    teamhub-api.openapi.yaml
  teamhub-agent-api/
    openapi.yaml            # Agent CLI -> TeamHub business API, incl. CLI files
  teamhub-internal/
    openapi.yaml            # Node Services / Voice Runtime -> TeamHub
  node-services-internal/
    openapi.yaml            # TeamHub -> Node Services (4319 and 4321)
runner-gateway/
  asyncapi.yaml             # Runner Gateway WebSocket channel
  envelope.schema.json
  fixtures/
fixtures/
  service-credentials/      # shared TypeScript and Go derivation vectors
generated/
  typescript/
    package.json            # @linger/wire-contracts
    src/
      generated/<id>/       # written by generation only
      generated/runner-gateway/
      <id>/client.ts        # handwritten clients and servers
  go/
    <package>/              # written by generation only
codegen/
  contracts.ts              # generate and verify every contract
```

The LLM Wiki operations in `node-services-internal` define the stateless document normalization and Wiki
refresh candidate generation that TeamHub calls; TeamHub owns scheduling,
source selection, and settlement.
After consolidation, `contracts/openapi` is the only authority. Applications
must not retain copied schemas or app-local generated wire DTOs.

Generate every language boundary from the authoritative OpenAPI with:

```bash
make contracts-generate
make contracts-verify
```

`contractEntries` in `codegen/contracts.ts` lists every top-level contract
once: its id, its entrypoint, and, when Go uses it, `go: { package, mode }` with mode `client`
(types and a client for Go callers) or `types` (types only, for the contracts
TeamHub serves through its own route table). Generation and verification read only that list. Generation
clears `generated/typescript/src/generated/` and each listed Go package
directory, bundles all references, and writes `types.ts` and `openapi.gen.go`
there. Verification generates into a temporary directory, compares those
directories whole, and fails on any directory that no contract owns.
Generated files are committed and never edited by hand.

Handwritten clients and servers live in `generated/typescript/src/<id>/` and
import their types from `../generated/<id>/types.js`. The package exports only
`<id>/types`, `<id>/client`, `<id>/server`, and the Runner Gateway `schema` and
`validator`.

To add a top-level contract, create `openapi/<id>/openapi.yaml`, add one
`contractEntries` entry, and run `make contracts-generate`. No Makefile or
test edit is needed.

JSON Schema and AsyncAPI directories are introduced only when a second real
protocol needs them.

## Local models flow

A Computer's model library is the `localmodels` tool's, reached through the
same chain as Skill scans. Schemas live in `openapi/components/local-models.yaml`
and the `LocalModel*` definitions of `runner-gateway/envelope.schema.json`.

Actions go Web → TeamHub → Agent Service → Computer → `localmodels`:

1. Web posts `actOnLocalComputerModel`
   (`POST /v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions`).
   Only the Computer owner may act.
2. TeamHub calls Node Services `actOnLocalComputerModels`
   (`POST /v1/tenants/{tenantId}/owners/{ownerActorId}/local-computers/{computerId}/local-model-actions`).
3. Agent Service sends `execute` with kind `local_models` (download, cancel,
   load with `unload_first`, unload, remove, or refresh). The Daemon answers
   `executed` with outcome `accepted` or `refused` at once and runs the
   `localmodels library` job itself. The ack returns to TeamHub as
   `LocalModelActionAck`; a refusal becomes a `LocalModelsErrorCode`.

Progress and outcomes travel back only as snapshots:

1. The Daemon sends `runner.local_models` with a `LocalModelsSnapshot` mapped
   from `localmodels.library-status/v1`: after `runner.hello`, after every
   library change, and at most every 2 seconds while a download or load runs.
   A Computer without the tool reports `available: false` with
   `TOOL_NOT_INSTALLED`.
2. Agent Service records it through TeamHub `recordAgentRuntimeLocalModels`
   (`POST /v0/agent-runtime/local-computers/local-models`). TeamHub keeps the
   latest snapshot per Computer, so an offline Computer shows what it last
   reported, and publishes a `local-models` invalidation hint whose id is the
   Computer ID.
3. Web reads `getLocalComputerModels`
   (`GET /v0/tenants/{tenantId}/local-computers/{computerId}/local-models`),
   where TeamHub adds each model's `used_by`: active Agents on that Computer
   with runtime `pi` whose runtime model is the model's `pi_model`. localmodels
   reports `pi_model` for every model on the Computer, loaded or not, so an
   idle model still lists the Agents that will run on it.
