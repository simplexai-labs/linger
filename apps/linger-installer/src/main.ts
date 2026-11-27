import path from "node:path";
import { lingerHome } from "@linger/local-installation/home";
import {
  windowsPrivateRefusal,
  type WindowsPrivateRefusal,
} from "@linger/local-installation/windows-private";
import type { LegacyInstanceSkipped } from "@linger/local-installation/legacy-migration";
import type { RuntimeDescriptor } from "@linger/local-installation/managed-runtimes";
import type { RuntimeLookupTimings } from "./server/instance-runtime.js";
import type { ResumeTimings } from "./server/resume.js";
import { fileURLToPath } from "node:url";
import { launchInstaller } from "./server/launch.js";
export { startInstallerServer } from "./server/server.js";
export { launchInstaller } from "./server/launch.js";
export function parseInstallerArguments(args: string[]) {
  const options: {
    home: string;
    sourceRepo?: string;
    externalComputer?: boolean;
    instanceName?: string;
    port?: number;
    noOpen?: boolean;
    resume?: boolean;
    inspect?: boolean;
    inspectTarget?: string;
    prefetchBifrost?: boolean;
    abortOnStdinClose?: boolean;
    byokCommand?: "check" | "models";
    userKeys?: boolean;
    migrate?: boolean;
    stop?: boolean;
    stopLocalModels?: boolean;
    prepareVoiceTools?: boolean;
  } = {
    home: lingerHome(),
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--no-open") {
      options.noOpen = true;
      continue;
    }
    if (flag === "--resume") {
      options.resume = true;
      continue;
    }
    if (flag === "--inspect") {
      options.inspect = true;
      continue;
    }
    if (flag === "--prefetch-bifrost") {
      options.prefetchBifrost = true;
      continue;
    }
    if (flag === "--abort-on-stdin-close") {
      options.abortOnStdinClose = true;
      continue;
    }
    if (flag === "--check-byok" || flag === "--list-byok-models") {
      options.byokCommand = flag === "--check-byok" ? "check" : "models";
      continue;
    }
    if (flag === "--migrate") {
      options.migrate = true;
      continue;
    }
    if (flag === "--stop") {
      options.stop = true;
      continue;
    }
    if (flag === "--stop-local-models") {
      options.stopLocalModels = true;
      continue;
    }
    if (flag === "--prepare-voice-tools") {
      options.prepareVoiceTools = true;
      continue;
    }
    if (flag === "--user-keys") {
      options.userKeys = true;
      continue;
    }
    if (flag === "--external-computer") {
      options.externalComputer = true;
      continue;
    }
    if (
      ![
        "--home",
        "--port",
        "--source-repo",
        "--instance",
        "--inspect-target",
      ].includes(flag ?? "")
    )
      throw new Error("Invalid installer option.");
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("Installer option is missing a value.");
    if (flag === "--home") options.home = path.resolve(value);
    else if (flag === "--inspect-target")
      options.inspectTarget = path.resolve(value);
    else if (flag === "--source-repo") options.sourceRepo = path.resolve(value);
    else if (flag === "--instance") {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(value))
        throw new Error("Invalid instance name.");
      options.instanceName = value;
    } else {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw new Error("Invalid installer port.");
      options.port = port;
    }
  }
  if (
    !options.sourceRepo &&
    !options.inspect &&
    !options.prefetchBifrost &&
    !options.byokCommand &&
    !options.userKeys &&
    !options.migrate &&
    !options.stop &&
    !options.stopLocalModels &&
    !options.prepareVoiceTools
  )
    throw new Error("The installer needs a source checkout (--source-repo).");
  if (options.inspectTarget && !options.inspect)
    throw new Error("An inspection target requires --inspect.");
  if (options.abortOnStdinClose && !options.prefetchBifrost)
    throw new Error("--abort-on-stdin-close requires --prefetch-bifrost.");
  if (options.resume && !options.instanceName)
    throw new Error("Resume needs a source checkout and an instance.");
  if (options.userKeys && !options.instanceName)
    throw new Error("Keys need an instance.");
  if (options.stop && !options.instanceName)
    throw new Error("Stop needs an instance.");
  if (options.prepareVoiceTools && !options.instanceName)
    throw new Error("Voice tools preparation needs an instance.");
  return options;
}
// The desktop client shows this line, so it carries the real cause; only an
// access error points at permissions.
export function startFailure(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  // Every line: a cause can list one reason per line.
  const reason =
    error instanceof Error ? error.message.trim().slice(0, 1500) : "";
  if (code === "EACCES" || code === "EPERM")
    return `Installer could not start: ${reason} Check the installation package and home directory permissions.`;
  return `Installer could not start${typeof code === "string" && code ? ` (${code})` : ""}: ${reason || "unknown error."}`;
}
// A leftover instance does not hold Linger back; the person still learns
// which one stayed behind and why.
export function legacySkippedWarning(skipped: LegacyInstanceSkipped): string {
  return `Linger could not convert the instance "${skipped.instance}" from the earlier Simplex app and left it as it was; it tries again at the next start. ${skipped.reason}`;
}
const failedToStart = (error: unknown) => {
  process.stderr.write(`${startFailure(error)}\n`);
  process.exitCode = 1;
};
// The line the desktop client reads on stdout when the installer manager
// could not start, so it acts on the cause by code, not by the words above.
export function startFailureLine(error: unknown): string | undefined {
  const refusal = windowsPrivateRefusal(error);
  return refusal ? `${JSON.stringify({ startFailure: refusal })}\n` : undefined;
}
const serveFailed = (error: unknown) => {
  const line = startFailureLine(error);
  if (line) process.stdout.write(line);
  failedToStart(error);
};
async function resume(options: ReturnType<typeof parseInstallerArguments>) {
  // Headless restart for the desktop client: progress on stderr, the outcome
  // as one JSON line on stdout.
  const [{ resumeSourceInstance }, { withLocalmodelsToolCache }] =
    await Promise.all([
      import("./server/resume.js"),
      import("@linger/local-installation/localmodels-tool"),
    ]);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  let runtimeDescriptors: RuntimeDescriptor[] | undefined;
  let resumeTimings: ResumeTimings | undefined;
  let runtimeLookupTimings: RuntimeLookupTimings | undefined;
  const { outcome, runtime } = await withLocalmodelsToolCache(async () => {
    const resumeOutcome = await resumeSourceInstance({
      home: options.home,
      sourceRepo: options.sourceRepo!,
      instanceName: options.instanceName!,
      externalComputer: options.externalComputer,
      onRuntimeDescriptors: (descriptors) => {
        runtimeDescriptors = descriptors;
      },
      onTimings: (timings) => {
        resumeTimings = timings;
      },
      signal: controller.signal,
      log: (message) => process.stderr.write(message.replace(/\n?$/, "\n")),
    }).catch((error: unknown) => ({
      code: 1,
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
      details: undefined,
    }));
    // The desktop's own Computer takes the runtime and localmodels tool paths
    // from every resume, so an install from before it knew one gains it.
    // The desktop does not read resume stderr, so timings ride in the outcome.
    const instanceRuntimeResult =
      resumeOutcome.code === 0 && options.externalComputer
        ? await import("./server/instance-runtime.js")
            .then(({ instanceRuntime }) =>
              instanceRuntime(options.home, options.instanceName!, {
                runtimeDescriptors,
                onTimings: (timings) => {
                  runtimeLookupTimings = timings;
                },
              }),
            )
            .catch(() => undefined)
        : undefined;
    return { outcome: resumeOutcome, runtime: instanceRuntimeResult };
  });
  // Detached service processes may keep handles open; exit once flushed.
  process.stdout.write(
    `${JSON.stringify({
      ...outcome,
      ...(runtime ? { runtime } : {}),
      ...(runtimeLookupTimings ? { runtimeLookupTimings } : {}),
      ...(resumeTimings ? { resumeTimings } : {}),
    })}\n`,
    () => process.exit(outcome.code),
  );
}
// Headless check of this computer for the desktop client: the setup report
// as the last JSON line on stdout. Before it, {"event":"download"} lines
// count the bytes while the check first downloads the localmodels tool.
async function inspect(options: ReturnType<typeof parseInstallerArguments>) {
  const { inspectSetup } =
    await import("@linger/local-installation/setup-plan");
  const startedAt = Date.now();
  let counted = 0;
  let refusal: WindowsPrivateRefusal | undefined;
  let failureMessage: string | undefined;
  const controller = new AbortController();
  const onTerm = () => controller.abort();
  process.once("SIGTERM", onTerm);
  // The desktop logs stderr, so a slow check says which part was slow.
  let report: Awaited<ReturnType<typeof inspectSetup>> | null;
  try {
    report = await inspectSetup({
      home: options.home,
      targetHome: options.inspectTarget,
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10 * 60_000),
      ]),
      onEvent: (event) => {
        if (event.kind === "log")
          process.stderr.write(event.message.replace(/\n?$/, "\n"));
        const progress = event.progress;
        if (event.kind !== "stage" || progress?.unit !== "bytes") return;
        // A download reports every chunk; a few lines a second are enough.
        const done = progress.total === progress.completed;
        if (!done && Date.now() - counted < 250) return;
        counted = Date.now();
        process.stdout.write(
          `${JSON.stringify({
            event: "download",
            completed: progress.completed,
            ...(progress.total ? { total: progress.total } : {}),
          })}\n`,
        );
      },
    }).catch((error: unknown) => {
      refusal = windowsPrivateRefusal(error);
      failureMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `The check failed${refusal ? ` (${refusal.code})` : ""}: ${failureMessage}\n`,
      );
      return null;
    });
  } finally {
    process.off("SIGTERM", onTerm);
  }
  process.stderr.write(
    `Checked this computer in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`,
  );
  const output =
    report ?? (refusal ? { error: failureMessage ?? "", refusal } : null);
  process.stdout.write(`${JSON.stringify(output)}\n`, () =>
    process.exit(report ? 0 : 1),
  );
}
// Headless background Bifrost pre-fetch for the desktop setup page: downloads
// the pinned Bifrost archive into localmodels' archive cache without allocating
// a port or starting the gateway, writing one JSON line on stdout.
async function prefetchBifrost(
  options: ReturnType<typeof parseInstallerArguments>,
) {
  const { prefetchLocalmodelsBifrost } =
    await import("@linger/local-installation/localmodels-tool");
  const controller = new AbortController();
  const onTerm = () => controller.abort();
  process.once("SIGTERM", onTerm);
  if (options.abortOnStdinClose) {
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      controller.abort();
    } else {
      process.stdin.once("end", onTerm);
      process.stdin.once("close", onTerm);
      process.stdin.resume();
    }
  }
  let result: Awaited<ReturnType<typeof prefetchLocalmodelsBifrost>>;
  try {
    result = await prefetchLocalmodelsBifrost(options.home, {
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10 * 60_000),
      ]),
    });
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.off("SIGTERM", onTerm);
    if (options.abortOnStdinClose) {
      process.stdin.off("end", onTerm);
      process.stdin.off("close", onTerm);
      process.stdin.pause();
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () =>
    process.exit(result.ok || result.unsupported ? 0 : 1),
  );
}
// Headless key update for the desktop client: the changes arrive as JSON on
// stdin so keys never appear in process arguments, and the names now set in
// the instance's user.env leave as one JSON line on stdout. Values are never
// echoed.
export async function saveUserKeys(
  options: { home: string; instanceName?: string },
  input: string,
): Promise<
  { saved: string[] } | { error: string; refusal?: WindowsPrivateRefusal }
> {
  const [{ instanceRoot }, { updateUserKeys }] = await Promise.all([
    import("@linger/local-installation/instance"),
    import("@linger/local-installation/user-environment"),
  ]);
  try {
    let changes: unknown;
    try {
      changes = JSON.parse(input);
    } catch {
      throw new Error("Invalid keys");
    }
    const saved = await updateUserKeys(
      instanceRoot({ name: options.instanceName!, home: options.home }),
      changes as never,
    );
    return { saved };
  } catch (error) {
    // The desktop client acts on a refused folder by its code and reason.
    const refusal = windowsPrivateRefusal(error);
    return {
      error: error instanceof Error ? error.message : "Cannot save keys",
      ...(refusal ? { refusal } : {}),
    };
  }
}
async function userKeys(options: ReturnType<typeof parseInstallerArguments>) {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const outcome = await saveUserKeys(options, input);
  process.stdout.write(`${JSON.stringify(outcome)}\n`, () =>
    process.exit("error" in outcome ? 1 : 0),
  );
}
// Headless BYOK endpoint check or model listing for the desktop setup page:
// the endpoint and key on stdin, one JSON line on stdout.
async function byokEndpointCommand(
  options: ReturnType<typeof parseInstallerArguments>,
  command: "check" | "models",
) {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const byok = await import("@linger/local-installation/byok-source");
  try {
    const value: unknown = JSON.parse(input);
    const result =
      command === "check"
        ? await byok.checkByokEndpoint(
            options.home,
            byok.validateByokConfiguration(value),
            AbortSignal.timeout(45_000),
          )
        : await byok.listByokModels(
            options.home,
            byok.validateByokEndpoint(value),
            AbortSignal.timeout(30_000),
          );
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not reach the BYOK endpoint.";
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    process.stdout.write(
      `${JSON.stringify({ ok: false, message, ...(code ? { code } : {}) })}\n`,
      () => process.exit(1),
    );
  }
}
// Headless stop for the desktop's uninstall: the outcome as one JSON line on
// stdout. The uninstall waits for it, so it ends on its own after a while.
async function stopInstallation(
  options: ReturnType<typeof parseInstallerArguments>,
) {
  const { stopDesktopInstallation } = await import("./server/stop.js");
  const { recordStopOutcome, stopFailure } =
    await import("./server/stop-diagnostics.js");
  const failures: ReturnType<typeof stopFailure>[] = [];
  const save = () =>
    Promise.race([
      recordStopOutcome(options.home, failures).catch(() => {
        process.stderr.write("Could not save stop diagnostics.\n");
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    ]);
  let expired = false;
  const watchdog = setTimeout(() => {
    expired = true;
    failures.push(stopFailure("helper", { name: "TimeoutError" }));
    void save().finally(() => process.exit(1));
  }, 150_000).unref();
  const outcome = await stopDesktopInstallation({
    home: options.home,
    instanceName: options.instanceName!,
    signal: AbortSignal.timeout(120_000),
    log: (message) => process.stderr.write(message.replace(/\n?$/, "\n")),
    onFailure: (stage, error) => failures.push(stopFailure(stage, error)),
  }).catch((error: unknown) => {
    failures.push(stopFailure("helper", error));
    return {
      failed: [
        {
          home: options.home,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  });
  if (expired) return;
  clearTimeout(watchdog);
  await save();
  process.stdout.write(`${JSON.stringify(outcome)}\n`, () =>
    process.exit(outcome.failed.length ? 1 : 0),
  );
}
// Headless stop of the local models for the desktop's quit: the outcome as
// one JSON line on stdout. The desktop does not wait for it to finish.
async function stopLocalModels(
  options: ReturnType<typeof parseInstallerArguments>,
) {
  const { stopDesktopLocalModels } = await import("./server/stop.js");
  setTimeout(() => process.exit(1), 150_000).unref();
  const outcome = await stopDesktopLocalModels({
    home: options.home,
    signal: AbortSignal.timeout(120_000),
    log: (message) => process.stderr.write(message.replace(/\n?$/, "\n")),
  }).catch((error: unknown) => ({
    failed: [
      {
        home: options.home,
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  }));
  process.stdout.write(`${JSON.stringify(outcome)}\n`, () =>
    process.exit(outcome.failed.length ? 1 : 0),
  );
}
// Detached background worker for cold first installs: extracts and verifies
// voice tools while the main install proceeds, then waits for "go\n" on stdin
// before starting native LiveKit.
async function prepareVoiceTools(
  options: ReturnType<typeof parseInstallerArguments>,
) {
  const { prepareVoiceToolsAndStartLiveKit } =
    await import("@linger/local-installation/native-source");
  const controller = new AbortController();
  const onStop = () => controller.abort();
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
  try {
    await prepareVoiceToolsAndStartLiveKit({
      home: options.home,
      instanceName: options.instanceName!,
      waitForGoOnStdin: true,
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(
      `Background voice tools preparation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
  }
  process.exit(0);
}
async function serve(options: ReturnType<typeof parseInstallerArguments>) {
  const { createVoiceToolsBackgroundLauncher } =
    await import("@linger/local-installation/native-source");
  const server = await launchInstaller({
    ...options,
    sourceRepo: options.sourceRepo!,
    launchVoiceToolsBackground: createVoiceToolsBackgroundLauncher(
      fileURLToPath(import.meta.url),
    ),
  });
  process.stdout.write(
    `Installer is running at ${server.origin}\nOpen the private launcher in your browser: ${path.join(options.home, "installer", "launch.html")}\nOn a remote Linux host, forward the installer port over SSH and open the private launcher on your computer.\n`,
  );
  const stop = () => {
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.closed;
}
// A packaged installer (the desktop client bundles one) carries the
// publisher's pinned localmodels, native PostgreSQL and Native voice tools
// next to it, in distribution.json.
export async function loadPublishedSources(
  file: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const [
    localmodelsTool,
    { readPublishedNativeSources, readPublishedVoiceTools },
  ] = await Promise.all([
    import("@linger/local-installation/localmodels-tool"),
    import("@linger/local-installation/native-dependencies"),
  ]);
  const tool = await localmodelsTool.readPublishedTool(file);
  if (tool && !environment.LINGER_LOCALMODELS_TOOL_JSON) {
    environment.LINGER_LOCALMODELS_TOOL_JSON = JSON.stringify(tool);
    if (!environment.LINGER_LOCALMODELS_TOOL_ARCHIVE) {
      const bundledArchive = localmodelsTool.bundledToolArchivePath(file);
      if (bundledArchive)
        environment.LINGER_LOCALMODELS_TOOL_ARCHIVE = bundledArchive;
    }
  }
  const native = await readPublishedNativeSources(file);
  if (native && !environment.LINGER_NATIVE_DEPENDENCIES_JSON)
    environment.LINGER_NATIVE_DEPENDENCIES_JSON = JSON.stringify(native);
  const voice = await readPublishedVoiceTools(file);
  if (voice && !environment.LINGER_NATIVE_VOICE_TOOLS_JSON)
    environment.LINGER_NATIVE_VOICE_TOOLS_JSON = JSON.stringify(voice);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let options: ReturnType<typeof parseInstallerArguments> | undefined;
  try {
    options = parseInstallerArguments(process.argv.slice(2));
    await loadPublishedSources(
      fileURLToPath(new URL("distribution.json", import.meta.url)),
    );
  } catch (error) {
    failedToStart(error);
  }
  // Installs from before the rename move to the Linger home once, before
  // any mode opens it; --migrate does only that, for the desktop client.
  // Inspecting, pre-fetching, or stopping for an uninstall or a quit never
  // migrates it.
  // Only --migrate reports the instances it skipped, as warnings and as one
  // JSON line on stdout: the desktop runs it first, and in the other modes a
  // warning on stderr would read as the reason a start failed. A skipped
  // instance is refused with its own error when a mode opens it.
  let skipped: LegacyInstanceSkipped[] = [];
  if (
    options &&
    !options.inspect &&
    !options.prefetchBifrost &&
    !options.stop &&
    !options.stopLocalModels &&
    !options.prepareVoiceTools
  )
    await import("@linger/local-installation/legacy-migration")
      .then(async ({ migrateLegacyInstallation }) => {
        skipped = await migrateLegacyInstallation({ home: options!.home });
        if (options?.migrate)
          for (const entry of skipped)
            process.stderr.write(`${legacySkippedWarning(entry)}\n`);
      })
      .catch((error: unknown) => {
        failedToStart(error);
        options = undefined;
      });
  if (options?.stop) await stopInstallation(options);
  else if (options?.stopLocalModels) await stopLocalModels(options);
  else if (options?.prepareVoiceTools) await prepareVoiceTools(options);
  else if (options?.migrate)
    process.stdout.write(`${JSON.stringify({ skipped })}\n`, () =>
      process.exit(0),
    );
  else if (options?.userKeys) await userKeys(options);
  else if (options?.byokCommand)
    await byokEndpointCommand(options, options.byokCommand);
  else if (options?.prefetchBifrost) await prefetchBifrost(options);
  else if (options?.inspect) await inspect(options);
  else if (options?.resume) await resume(options);
  else if (options) await serve(options).catch(serveFailed);
}
