import path from "node:path";
import { probeRuntimesWithDaemon } from "./daemon-runtime-probe.js";
import { runLocalmodels } from "./localmodels-tool.js";
import {
  descriptorFromDaemonObservation,
  discoverManagedRuntimeExecutable,
  inspectRuntimeDescriptors,
  inspectSelectedRuntimeDescriptors,
  readModelSourceRuntimeHints,
  runtimeEnvironmentFromDescriptors,
  runtimeProfileEnvFor,
  type RuntimeDescriptor,
} from "./managed-runtimes.js";
import { readSetupChoice } from "./setup-selection.js";
import { validateModelConfig } from "./instance.js";
export interface RuntimeModel {
  baseUrl: string;
  model: string;
  apiKey: string;
}
export async function configureManagedCodex(
  root: string,
  model: RuntimeModel,
  signal: AbortSignal,
  dependencies: { localmodels?: typeof runLocalmodels } = {},
) {
  return codexConfiguration(
    path.resolve(root, "../.."),
    model,
    signal,
    dependencies,
    false,
  );
}
export async function checkRuntimeModel(
  model: RuntimeModel,
  signal: AbortSignal,
  dependencies: { home: string; localmodels?: typeof runLocalmodels },
) {
  return codexConfiguration(
    dependencies.home,
    model,
    signal,
    dependencies,
    true,
  );
}
/** Thin adapter for upstream-owned Responses verification and native configuration. */
async function codexConfiguration(
  home: string,
  model: RuntimeModel,
  signal: AbortSignal,
  dependencies: { localmodels?: typeof runLocalmodels },
  check: boolean,
) {
  validateModelConfig(model);
  signal.throwIfAborted();
  try {
    const result = await (dependencies.localmodels ?? runLocalmodels)(
      home,
      [
        "harness",
        "auth",
        "--root",
        path.join(home, "runtime", "harness"),
        "--runtime",
        "codex",
        "--config-stdin",
        ...(check ? ["--check"] : []),
        "--json",
      ],
      {
        signal,
        timeoutMs: 120000,
        input: JSON.stringify({
          provider: "openai-compatible",
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          modelId: model.model,
          wireApi: "responses",
        }),
      },
    );
    if (
      result.code !== 0 ||
      (!check && JSON.parse(result.stdout).saved !== true)
    )
      throw new Error("Upstream rejected model configuration");
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "Runtime model configuration failed. Check the provider settings and network, then retry.",
    );
  }
}
export async function readManagedModel(
  root: string,
  dependencies: { localmodels?: typeof runLocalmodels } = {},
) {
  const rows = await inspectRuntimeDescriptors(
    path.resolve(root, "../.."),
    { runtime: "codex" },
    dependencies,
  );
  return rows.find((row) => row.runtime === "codex")?.modelConfig ?? undefined;
}
export async function managedRuntimeEnvironment(
  home: string,
  root = home,
  dependencies: {
    localmodels?: typeof runLocalmodels;
    probeRuntimes?: typeof probeRuntimesWithDaemon;
    daemonExecutable?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const choice = await readSetupChoice({ root });
  if (!choice || choice === "local-models") return {};
  const platform = dependencies.platform ?? process.platform;
  const hints = await readModelSourceRuntimeHints(home);
  const profileEnv = runtimeProfileEnvFor(choice, hints.environment);
  const configured = await discoverManagedRuntimeExecutable(
    home,
    choice,
    platform,
    hints.runtimePaths,
  );
  const probe = dependencies.probeRuntimes ?? probeRuntimesWithDaemon;
  const observations = await probe({
    runtimes: [choice],
    ...(configured ? { configuredPaths: { [choice]: configured } } : {}),
    includeBundled: true,
    env: { ...(dependencies.env ?? process.env), ...profileEnv },
    daemonExecutable: dependencies.daemonExecutable,
    platform,
  });
  if (observations !== null) {
    const obs = observations.find((item) => item.type === choice);
    if (obs && obs.status !== "error") {
      const seed: RuntimeDescriptor = {
        runtime: choice,
        executable: null,
        argvPrefix: [],
        installed: false,
        authenticated: false,
        authMode: null,
        loginCommand: null,
        ...(Object.keys(profileEnv).length > 0
          ? { environment: profileEnv }
          : {}),
      };
      const descriptor = descriptorFromDaemonObservation(choice, obs, seed);
      return runtimeEnvironmentFromDescriptors([descriptor]);
    }
  }
  return runtimeEnvironmentFromDescriptors(
    await inspectSelectedRuntimeDescriptors(home, root, dependencies),
  );
}
