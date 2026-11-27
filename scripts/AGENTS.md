# Repository Scripts: Repeatable local development automation

Scripts support existing build, generation, and verification entrypoints.

## Common Commands

- `pnpm vitest run --no-file-parallelism scripts/<test-file>`: run one script test.
- `pnpm dev:windows`: start the host development stack on Windows, which has
  neither `sh` nor `make`. It runs the steps `pnpm dev` orchestrates.
- `pnpm computer:release:windows`: build the Local Computer release a Windows
  checkout serves from `/install/`.
- `make check-scripts-fast`: run the fast repository script gate with bounded parallelism.
- `make check-computer-release`: build and install the real Local Computer bundle.
- `make check-scripts-heavy`: run Local Computer install, package, and release tests.
- `make check-scripts`: run both script-test layers.

## Structure

- Keep automation in small Bash or TypeScript modules with colocated tests.
- Script telemetry must be structured, bounded, and free of credentials or business payloads.
- Write transient logs and PIDs under `.linger-runtime/`.

## Important Conventions

- Scripts must be idempotent and safe to rerun.
- When a managed-tools smoke command times out on Linux and neither process
  group signaling nor the procfs children index works, take one bounded
  `ps` PID/PPID snapshot before signaling the owned processes individually.
- Build Local Computer Linux and macOS archives on a Unix host so the tar
  entries retain executable modes. On Windows, pass `--targets win32-x64`
  or `--targets win32-arm64` to `prepare-local-computer-release.mjs`.
- The PowerShell installer loads its built-in cmdlets from the current shell
  so it works when launched by either Windows PowerShell 5.1 or PowerShell 7.
- `check-scripts-fast` runs fast-lane files that reference `child_process`
  under `SCRIPT_TEST_PROCESS_TIMEOUT_MS`; pure files keep the 5s Vitest default.
  New process-spawning tests need no per-test timeout for the shared Runner.
- Do not introduce workflow gates when existing lint, typecheck, tests, or generation checks suffice.
- Never store secrets, generated database dumps, or long-lived state here.
- During ordinary `scripts/**` iteration, run the focused test and then
  `make check-scripts-fast`. Changes to the Local Computer installer,
  uninstaller, installer fixtures, bundle or manifest generation, signatures,
  or release images must also run `make check-scripts-heavy` locally.
- Before delivery, run `make check BASE=<target-branch>`, which runs the
  fast checks the change selects through `scripts/check-plan.mjs`. Do not replace installer security failures,
  the complete install path, signature or rollback checks, or release
  integrity with pure unit coverage unless equivalent end-to-end coverage is
  identified and documented.
- Installer tests may share only immutable source artifacts. Every concurrent
  case must keep a private HOME, install root, state directory, and invocation
  log; cleanup runs only after all concurrent cases settle. Use
  `SCRIPT_TEST_INSTALLER_CONCURRENCY=1` when diagnosing a concurrency-sensitive
  failure. Do not add automatic retries.
- Verify dependency-scope changes from a checkout without existing node_modules.
- `SCRIPT_ISOLATED_PROCESS_TESTS` uses two workers and `SCRIPT_FAST_PROCESS_TESTS`
  one by default. New process tests must use private temp directories and
  `listen(0)` ports, never shared paths, fixed ports or global Git config.
  Audit private filesystem/process/port ownership before adding a process
  suite, and compare the new suite with one and two workers.
- `SCRIPT_TEST_PROCESS_TIMEOUT_MS` controls only the Vitest harness budget for
  process tests that create real Git, pnpm, apt, or process-tree fixtures. It is
  not a product deadline and must not replace their internal timeout and
  cleanup assertions.
