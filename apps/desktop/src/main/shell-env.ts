import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The daemon and the runtimes it starts need the environment the user's
// terminal has. An app opened from Finder or the Dock only gets
// PATH=/usr/bin:/bin:/usr/sbin:/sbin and none of the shell profile's settings.

const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const TERMINAL_VARIABLES = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
] as const;
const ENV_MARKER = "__LINGER_ENV__";
const FNM_MULTISHELLS_DIR = "fnm_multishells";
const FNM_MULTISHELL_VAR = "FNM_MULTISHELL_PATH";
// Shell bookkeeping, not settings; PATH is merged by runtimeSearchPath.
const SHELL_ONLY_VARIABLES = new Set([
  "PATH",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  FNM_MULTISHELL_VAR,
]);

// Where package managers and installers usually put the Codex and Claude
// CLIs, searched even when the login shell lookup fails.
const COMMON_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.local/bin",
  "~/.npm-global/bin",
  "~/.volta/bin",
  "~/.bun/bin",
  "~/.claude/local",
];

export type RunShell = (
  shell: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env: NodeJS.ProcessEnv },
) => Promise<{ readonly code: number; readonly stdout: string }>;

const runShell: RunShell = (shell, args, options) =>
  new Promise((resolve) => {
    execFile(
      shell,
      args,
      { timeout: options.timeoutMs, env: options.env, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resolve({ code: error ? -1 : 0, stdout: String(stdout) });
      },
    );
  });

const userShell = (): string | undefined => {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
};

interface FnmMultishellMatch {
  readonly linkPath: string;
  readonly suffix: string;
}

function cleanPosixEntry(entry: string): string {
  return process.platform === "win32" ? entry : path.posix.resolve(entry);
}

interface PreparedFnmLookup {
  readonly fallback: string;
  readonly matched?: FnmMultishellMatch;
}

function matchFnmMultishellEntry(
  cleanEntry: string,
  multishellPath?: string,
): FnmMultishellMatch | undefined {
  if (multishellPath && path.isAbsolute(multishellPath)) {
    const cleanMultishell = cleanPosixEntry(multishellPath);
    if (cleanEntry === cleanMultishell) {
      return { linkPath: cleanMultishell, suffix: "" };
    }
    if (cleanEntry === path.join(cleanMultishell, "bin")) {
      return { linkPath: cleanMultishell, suffix: "bin" };
    }
  }
  const parent = path.dirname(cleanEntry);
  if (
    path.basename(cleanEntry) === "bin" &&
    path.basename(path.dirname(parent)) === FNM_MULTISHELLS_DIR
  ) {
    return { linkPath: parent, suffix: "bin" };
  }
  if (path.basename(parent) === FNM_MULTISHELLS_DIR) {
    return { linkPath: cleanEntry, suffix: "" };
  }
  return undefined;
}

function prepareFnmLookup(
  entry: string,
  multishellPath?: string,
): PreparedFnmLookup {
  if (!path.isAbsolute(entry)) return { fallback: entry };
  const clean = cleanPosixEntry(entry);
  return {
    fallback: clean,
    matched: matchFnmMultishellEntry(clean, multishellPath),
  };
}

function resolveFnmTargetCandidate(
  matched: FnmMultishellMatch,
  target: string,
): string {
  const resolvedTarget = path.isAbsolute(target)
    ? cleanPosixEntry(target)
    : path.resolve(path.dirname(matched.linkPath), target);
  return matched.suffix
    ? path.join(resolvedTarget, matched.suffix)
    : resolvedTarget;
}

async function resolveFnmMultishellEntry(
  entry: string,
  multishellPath?: string,
): Promise<string> {
  const { fallback, matched } = prepareFnmLookup(entry, multishellPath);
  if (!matched) return fallback;
  try {
    const info = await fsp.lstat(matched.linkPath);
    if (!info.isSymbolicLink()) return fallback;
    const target = await fsp.readlink(matched.linkPath);
    if (!target) return fallback;
    const resolved = resolveFnmTargetCandidate(matched, target);
    return (await fsp.stat(resolved)).isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

function resolveFnmMultishellEntrySync(entry: string): string {
  const { fallback, matched } = prepareFnmLookup(entry);
  if (!matched) return fallback;
  try {
    const info = fs.lstatSync(matched.linkPath);
    if (!info.isSymbolicLink()) return fallback;
    const target = fs.readlinkSync(matched.linkPath);
    if (!target) return fallback;
    const resolved = resolveFnmTargetCandidate(matched, target);
    return fs.statSync(resolved).isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

async function cleanupFnmMultishellSymlink(
  childPath: string | undefined,
  parentPath: string | undefined,
): Promise<void> {
  if (!childPath || !path.isAbsolute(childPath)) return;
  const cleanChild = cleanPosixEntry(childPath);
  if (path.basename(path.dirname(cleanChild)) !== FNM_MULTISHELLS_DIR) return;
  if (
    parentPath &&
    path.isAbsolute(parentPath) &&
    cleanChild === cleanPosixEntry(parentPath)
  ) {
    return;
  }
  try {
    const info = await fsp.lstat(cleanChild);
    if (!info.isSymbolicLink()) return;
    await fsp.unlink(cleanChild);
  } catch {
    // Best-effort cleanup; ignore ENOENT or already-removed symlinks.
  }
}

// The environment as the user's terminal sees it: PATH, API keys, proxy and CA
// certificate settings from the shell profile. Interactive so that version
// managers set up in .zshrc / .bashrc (nvm, volta) are included; markers keep
// any banner the shell prints out of the result.
export const loginShellEnvironment = async (
  env: NodeJS.ProcessEnv = process.env,
  run: RunShell = runShell,
): Promise<Record<string, string> | undefined> => {
  if (process.platform === "win32") return undefined;
  // Without SHELL (e.g. a stripped child environment) use the account shell.
  const shell = (env.SHELL ?? userShell())?.trim();
  if (!shell || !path.isAbsolute(shell)) return undefined;
  const script = `printf '${ENV_MARKER}'; /usr/bin/env -0; printf '${ENV_MARKER}'`;
  // Start from what a new terminal window gets, so the shell's own PATH order
  // wins over the app's inherited one.
  const terminalEnv = {
    ...Object.fromEntries(
      TERMINAL_VARIABLES.flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]]],
      ),
    ),
    SHELL: shell,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const parentMultishell = env[FNM_MULTISHELL_VAR];
  const parseShellOutput = ({
    code,
    stdout,
  }: {
    readonly code: number;
    readonly stdout: string;
  }): Record<string, string> => {
    const match = new RegExp(`${ENV_MARKER}(.*?)${ENV_MARKER}`, "s").exec(
      stdout,
    );
    return code === 0 ? parseEnv(match?.[1] ?? "") : {};
  };
  const stabilizeWinnerPath = async (
    winner: Record<string, string>,
  ): Promise<void> => {
    if (!winner.PATH) return;
    const resolvedEntries = await Promise.all(
      winner.PATH.split(path.delimiter)
        .filter((directory) => directory && path.isAbsolute(directory))
        .map((directory) =>
          resolveFnmMultishellEntry(directory, winner[FNM_MULTISHELL_VAR]),
        ),
    );
    const stabilizedPath = [...new Set(resolvedEntries)].join(path.delimiter);
    if (stabilizedPath) {
      winner.PATH = stabilizedPath;
    }
  };
  const probe = (flags: "-ilc" | "-lc"): Promise<Record<string, string>> =>
    run(shell, [flags, script], {
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      env: terminalEnv,
    })
      .catch(() => ({ code: -1, stdout: "" }))
      .then(parseShellOutput);

  // Both shells start together so a hanging .zshrc costs one timeout instead
  // of two; when `-ilc` succeeds with PATH, return immediately while still
  // cleaning up `-lc`'s probe symlink once it finishes.
  const interactivePromise = probe("-ilc");
  let loginSettled = false;
  let loginVariables: Record<string, string> | undefined;
  let loginCleanup: Promise<void> | undefined;
  let interactiveWon = false;

  const loginPromise = probe("-lc").then((variables) => {
    loginSettled = true;
    loginVariables = variables;
    if (interactiveWon) {
      loginCleanup = cleanupFnmMultishellSymlink(
        variables[FNM_MULTISHELL_VAR],
        parentMultishell,
      ).catch(() => undefined);
    }
    return variables;
  });

  const interactive = await interactivePromise;
  if (interactive.PATH) {
    await stabilizeWinnerPath(interactive);
    interactiveWon = true;
    await cleanupFnmMultishellSymlink(
      interactive[FNM_MULTISHELL_VAR],
      parentMultishell,
    );
    if (loginSettled) {
      loginCleanup ??= cleanupFnmMultishellSymlink(
        loginVariables?.[FNM_MULTISHELL_VAR],
        parentMultishell,
      ).catch(() => undefined);
      await loginCleanup;
    }
    delete interactive[FNM_MULTISHELL_VAR];
    return interactive;
  }

  const login = await loginPromise;
  if (login.PATH) {
    await stabilizeWinnerPath(login);
  }
  await Promise.all([
    cleanupFnmMultishellSymlink(
      interactive[FNM_MULTISHELL_VAR],
      parentMultishell,
    ),
    cleanupFnmMultishellSymlink(login[FNM_MULTISHELL_VAR], parentMultishell),
  ]);
  if (login.PATH) {
    delete login[FNM_MULTISHELL_VAR];
    return login;
  }
  return undefined;
};

const parseEnv = (text: string): Record<string, string> => {
  const variables: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    if (separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      variables[key] = entry.slice(separator + 1);
  }
  return variables;
};

export interface SearchPathOptions {
  readonly platform?: NodeJS.Platform;
}

function pathImplForPlatform(
  platform: NodeJS.Platform,
): typeof path.posix | typeof path.win32 {
  if (platform === process.platform) return path;
  return platform === "win32" ? path.win32 : path.posix;
}

function resolveSearchPathKeyConfig(
  source: Readonly<Record<string, string>>,
  login: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform,
  delimiter: string,
): {
  readonly pathKey: string;
  readonly currentPath: string | undefined;
  readonly loginPath: string | undefined;
} {
  let pathKey = "PATH";
  let matchedKey = false;
  const currentEntries: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!/^path$/i.test(key)) continue;
    if (!matchedKey && platform === "win32") {
      pathKey = key;
      matchedKey = true;
    }
    if (value) currentEntries.push(value);
  }
  const loginEntries: string[] = [];
  for (const [key, value] of Object.entries(login ?? {})) {
    if (/^path$/i.test(key) && value) loginEntries.push(value);
  }
  return {
    pathKey,
    currentPath:
      currentEntries.length > 0 ? currentEntries.join(delimiter) : undefined,
    loginPath:
      loginEntries.length > 0 ? loginEntries.join(delimiter) : undefined,
  };
}

// The login shell's PATH first, so `codex` and `claude` resolve to the same
// executables as in the user's terminal, then the inherited PATH, then the
// common install directories.
export const runtimeSearchPath = (
  current: string | undefined,
  login: string | undefined,
  home = os.homedir(),
  options?: SearchPathOptions,
): string => {
  const platform = options?.platform ?? process.platform;
  const pathImpl = pathImplForPlatform(platform);
  const directories = [
    ...(login ?? "").split(pathImpl.delimiter),
    ...(current ?? "").split(pathImpl.delimiter),
    ...(platform === "win32"
      ? []
      : COMMON_DIRECTORIES.map((directory) =>
          directory.startsWith("~/")
            ? pathImpl.join(home, directory.slice(2))
            : directory,
        )),
  ]
    .filter((directory) => directory && pathImpl.isAbsolute(directory))
    .map((directory) =>
      platform === "win32"
        ? directory
        : resolveFnmMultishellEntrySync(directory),
    );
  return [...new Set(directories)].join(pathImpl.delimiter);
};

// An app opened from an agent session's terminal (e.g. `open -a` inside
// Claude Code) inherits that session's identity and, when the host manages
// the provider, its gateway URL, token and model ids, which are invalid
// outside the host. A Dock or Finder launch has none of them.
const withoutParentAgentSession = (
  env: Readonly<Record<string, string>>,
): Record<string, string> => {
  const hostManagedProvider = Boolean(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST);
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/i.test(key) &&
        !(hostManagedProvider && /^ANTHROPIC_/i.test(key)),
    ),
  );
};

// The app's environment, without a parent agent session's variables, plus the
// terminal's PATH and the shell variables the app was not started with. What
// the app already has wins.
export const withLoginShell = (
  env: Readonly<Record<string, string>>,
  login: Readonly<Record<string, string>> | undefined,
  home = os.homedir(),
  options?: SearchPathOptions,
): Record<string, string> => {
  const platform = options?.platform ?? process.platform;
  const pathImpl = pathImplForPlatform(platform);
  const merged = withoutParentAgentSession(env);
  for (const [key, value] of Object.entries(login ?? {}))
    if (
      merged[key] === undefined &&
      !SHELL_ONLY_VARIABLES.has(key) &&
      !/^path$/i.test(key)
    )
      merged[key] = value;
  const { pathKey, currentPath, loginPath } = resolveSearchPathKeyConfig(
    env,
    login,
    platform,
    pathImpl.delimiter,
  );
  for (const key of Object.keys(merged)) {
    if (/^path$/i.test(key)) delete merged[key];
  }
  merged[pathKey] = runtimeSearchPath(currentPath, loginPath, home, options);
  return merged;
};
