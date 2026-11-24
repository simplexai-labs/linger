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
   `TOOL_NOT_INSTALLED`. Each `LocalModel` may also carry optional model-card
   metadata (`family`, `publisher`, `architecture`, `parameters`,
   `active_parameters`, `capabilities`, `license`, `source_url`,
   `prompt_tokens_per_second`). Extended diagnostic reasons (`GPU_UNSUPPORTED`,
   `DRIVER_UPDATE_REQUIRED`, `RUNTIME_DEPENDENCY_MISSING`, `UNAVAILABLE` and
   their structured fields), extended error codes, and optional `debug`
   metadata are sent only when `runner.welcome`'s `service_features` declares
   `local_models_diagnostics` (`FIRST_LOCAL_MODELS_DIAGNOSTICS_COMPUTER_VERSION`,
   `0.58.0`); otherwise the Daemon downgrades them for older Agent Services.
   Per-model inference engine metadata (`engine`, `engine_label`, `concurrency`,
   `host_ram_bytes`) is sent only when `runner.welcome`'s `service_features`
   declares `local_models_engine` (`FIRST_LOCAL_MODELS_ENGINE_COMPUTER_VERSION`,
   `0.61.0`); otherwise the Daemon strips those fields for older Agent Services.
   Per-model `concurrency_probing` is sent only when `runner.welcome`'s
   `service_features` declares `local_models_concurrency_probe`
   (`FIRST_LOCAL_MODELS_CONCURRENCY_PROBE_COMPUTER_VERSION`, `0.64.0`);
   otherwise the Daemon strips it for older Agent Services.
   Pool `external_holders` is sent only when `service_features` declares
   `local_models_external_holders` (to every Computer, which ignores unknown
   features); otherwise the Daemon strips it. `[]` means localmodels found no
   closeable app, while an absent field means not reported.
   `service_features` also declares `local_model_unavailable` to every Computer
   that receives the field: a Daemon ignores a feature it does not know, and one
   that knows it reports a Pi Run whose local model it could not load with that
   Run failure code instead of `model_unavailable`.
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

## Model source flow

Which source a Computer's Agents use (local model, subscription or BYOK) is
the `localmodels` tool's `<state>/model-source.json`. Schemas live in
`openapi/components/model-source.yaml` and the `CapabilityModelSource*`
definitions of `runner-gateway/envelope.schema.json`.

Web → TeamHub → Agent Service → Computer → `localmodels source`:

1. Web calls `getLocalComputerModelSource`, `switchLocalComputerModelSource`,
   `testLocalComputerModelSource` or `listLocalComputerByokModels` under
   `/v0/tenants/{tenantId}/local-computers/{computerId}/model-source`. Only the
   Computer owner sees the source or acts on it.
2. TeamHub calls Node Services `getLocalComputerModelSource`,
   `applyLocalComputerModelSource`, `testLocalComputerByok` or
   `listLocalComputerByokModels` under
   `/v1/tenants/{tenantId}/owners/{ownerActorId}/local-computers/{computerId}/model-source`.
3. Agent Service sends `execute` with kind `model_source` (`status`, `test`,
   `models` or `apply`), only to Computer 0.54.0 or later; an older Computer,
   or one whose installed `localmodels` tool lacks the `source` command, answers
   `MODEL_SOURCE_UNSUPPORTED`. The Daemon runs
   `localmodels source status|check|models|apply` and answers `executed`. A BYOK
   API key travels in the request and the envelope only, reaches `localmodels`
   on stdin, and is kept on the Computer in an owner-only file.

A BYOK input names its address as `base_url`, `path` and `endpoint`, with the
`protocol` the owner's client derived from the address's ending (else the
Runtime's own format). Requests go to `base_url + path + endpoint`, models are
listed at `base_url + path + /models`, and nothing is probed. Agent Service
sends a BYOK input only to Computer 0.56.0 or later
(`FIRST_BYOK_ENDPOINT_COMPUTER_VERSION`), and declares `byok_endpoint` in
`runner.welcome`'s `service_features` to the same releases; the Computer's BYOK
summary carries `path` and `endpoint` only after that declaration, because an
older Agent Service rejects unknown summary keys.

A switch runs `apply` on the Computer first, then moves the owner's Agents on it
to the Runtime and model it now serves, in one TeamHub transaction. An Agent
with running work stays where it is unless the owner chose to end that work:
work found before `apply` refuses the switch with `AGENT_HAS_ACTIVE_RUNS`, and
work that started during it leaves only that Agent behind, answered with the
same code after the others moved.

## Stop hook flow

A Feature may register a `stop` hook on an Agent Run so the Runtime asks the
Agent Service before finishing a turn:

1. Agent Service sets `stop_hook: true` on `provider.prepare`
   (`run_context.stop_hook`), `operation.prepare` (`stop_hook`), and
   `operation.start` (`request.run_context.stop_hook`) only when the Run's
   composed Features have a `stop` hook and the Computer is version `0.57.0` or
   later (`FIRST_STOP_HOOK_COMPUTER_VERSION`). Older Computers decode
   `provider.prepare` and `operation.prepare` with `DisallowUnknownFields()` and
   would close the connection on an unknown field; omitting `stop_hook` keeps
   older Computers compatible and falls back to Agent Service's post-hoc
   `reply_not_sent` check.
2. When the Runtime is about to finish a turn, the Daemon emits an
   `operation.event` carrying `human_interaction.requested` with
   `kind: "runtime_hook"` and `hook: "stop"`, and waits for an
   `operation.input` `runtime_response` (`{ action: "allow" | "block", reason? }`).
   On `block`, the Runtime continues the turn with that reason (Claude Code and
   Codex via their native `Stop` hooks; Pi via a follow-up `prompt` RPC on the
   bound process). Timeout, disconnect, or an invalid decision fails open to
   `allow`.

## Model invocation outcomes

`executed` `model_invoke` reports `context_too_long` (prompt exceeded the
model's context window) and `unsupported` (the target Runtime does not support
the requested mode, such as Pi workspace calls) only after `runner.welcome`'s
`service_features` names `model_invoke_outcomes`
(`FIRST_MODEL_INVOKE_OUTCOMES_COMPUTER_VERSION`, `0.60.0`); otherwise the
Daemon downgrades them to `failed` and `runtime_unavailable` for older Agent
Services.
