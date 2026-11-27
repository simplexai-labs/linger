// Pure configuration parser and environment resolver for `scripts/dev.mjs`.
import { existsSync } from "node:fs";
import path from "node:path";

export const DEV_USAGE = `Usage: pnpm --filter @linger/desktop dev -- [options] [-- <electron-args...>]

Watch desktop, installer, and Go daemon sources, rebuild incrementally, and
auto-restart Electron in an isolated development profile.

Options:
  --server <url>               Connect directly to a running server (e.g. http://127.0.0.1:3000 for Web HMR)
  --quick-install              Test the Quick Install flow against this checkout (sets LINGER_CHECKOUT)
  --checkout <dir>             Explicit LINGER_CHECKOUT directory for Quick Install
  --localmodels <dir>          Path to an llm-inference-lab checkout (Python edits apply live without restarts)
  --localmodels-python <path>  Explicit Python executable for --localmodels (defaults to <dir>/.venv)
  --debug <spec>               Set LOCALMODELS_DEBUG (e.g. simulate, tiny, simulate:download_ms=1500,vram_gb=24)
  --profile <name>             Isolated profile under .linger-runtime/desktop-dev/<name> (default: dev)
  --reset                      Wipe the isolated profile's user-data and home before launch
  --skip-daemon                Skip Go daemon rebuilds when a daemon binary is already present
  --with-computer-tools        Download/stage browser & CUA tools if not already cached in dist/
  --no-watch                   Build once, launch Electron, and exit when Electron exits
  --dry-run                    Print the resolved dev session plan as JSON and exit
  -h, --help                   Show this help text
`;

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DEV_FLAGS = new Set([
  "--help",
  "-h",
  "--server",
  "--quick-install",
  "--checkout",
  "--localmodels",
  "--localmodels-python",
  "--debug",
  "--profile",
  "--reset",
  "--skip-daemon",
  "--with-computer-tools",
  "--no-watch",
  "--dry-run",
  "--",
]);

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-"))
    throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseDevArgs(argv) {
  // pnpm forwards a literal leading "--" when invoked as
  // `pnpm --filter @linger/desktop dev -- --server ...`. Strip it when the
  // next token is a dev runner flag or a second "--" for Electron args.
  const effectiveArgv =
    argv[0] === "--" && argv.length > 1 && DEV_FLAGS.has(argv[1])
      ? argv.slice(1)
      : argv;
  const options = {
    help: false,
    server: undefined,
    quickInstall: false,
    checkout: undefined,
    localmodels: undefined,
    localmodelsPython: undefined,
    debug: undefined,
    profile: "dev",
    reset: false,
    skipDaemon: false,
    withComputerTools: false,
    watch: true,
    dryRun: false,
    electronArgs: [],
  };

  for (let i = 0; i < effectiveArgv.length; i += 1) {
    const arg = effectiveArgv[i];
    if (arg === "--") {
      options.electronArgs = effectiveArgv.slice(i + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--quick-install") {
      options.quickInstall = true;
      continue;
    }
    if (arg === "--reset") {
      options.reset = true;
      continue;
    }
    if (arg === "--skip-daemon") {
      options.skipDaemon = true;
      continue;
    }
    if (arg === "--with-computer-tools") {
      options.withComputerTools = true;
      continue;
    }
    if (arg === "--no-watch") {
      options.watch = false;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--server") {
      const value = takeValue(effectiveArgv, i, arg);
      i += 1;
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`Invalid --server URL: ${value}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error(`--server must use http or https: ${value}`);
      options.server = parsed.origin;
      continue;
    }
    if (arg === "--checkout") {
      options.checkout = takeValue(effectiveArgv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--localmodels") {
      options.localmodels = takeValue(effectiveArgv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--localmodels-python") {
      options.localmodelsPython = takeValue(effectiveArgv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--debug") {
      options.debug = takeValue(effectiveArgv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--profile") {
      const value = takeValue(effectiveArgv, i, arg);
      i += 1;
      if (!PROFILE_NAME.test(value))
        throw new Error(
          `Invalid --profile name ${JSON.stringify(value)} (use letters, digits, ., _, -).`,
        );
      options.profile = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.server && options.quickInstall)
    throw new Error("--server and --quick-install cannot be combined.");

  return options;
}

export function resolveLocalmodelsPython(
  moduleDir,
  explicitPython,
  {
    exists = existsSync,
    platform = process.platform,
    findOnPath = defaultFindOnPath,
  } = {},
) {
  if (explicitPython) {
    const resolved = path.resolve(explicitPython);
    if (!exists(resolved))
      throw new Error(`--localmodels-python does not exist: ${resolved}`);
    return resolved;
  }
  const candidates =
    platform === "win32"
      ? [
          path.join(moduleDir, ".venv", "Scripts", "python.exe"),
          path.join(moduleDir, ".venv", "bin", "python"),
        ]
      : [
          path.join(moduleDir, ".venv", "bin", "python"),
          path.join(moduleDir, ".venv", "bin", "python3"),
        ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const fallback =
    findOnPath(platform === "win32" ? "python.exe" : "python3") ??
    (platform === "win32" ? findOnPath("python") : undefined);
  if (fallback) return fallback;
  throw new Error(
    `No Python executable found under ${path.join(moduleDir, ".venv")} or on PATH; pass --localmodels-python.`,
  );
}

function defaultFindOnPath(name, env = process.env) {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function resolveDevSession(
  options,
  {
    repoRoot,
    env = process.env,
    exists = existsSync,
    platform = process.platform,
    arch = process.arch,
    findOnPath = (name) => defaultFindOnPath(name, env),
  },
) {
  const resolvedRoot = path.resolve(repoRoot);
  const profileRoot = path.join(
    resolvedRoot,
    ".linger-runtime",
    "desktop-dev",
    options.profile,
  );
  const userData = env.LINGER_DESKTOP_USER_DATA?.trim()
    ? path.resolve(env.LINGER_DESKTOP_USER_DATA.trim())
    : path.join(profileRoot, "user-data");
  const home = env.LINGER_HOME?.trim()
    ? path.resolve(env.LINGER_HOME.trim())
    : path.join(profileRoot, "home");

  const serverUrl = options.quickInstall
    ? undefined
    : (options.server ?? env.LINGER_SERVER_URL?.trim()) || undefined;
  const checkout = options.checkout
    ? path.resolve(options.checkout)
    : options.quickInstall
      ? resolvedRoot
      : env.LINGER_CHECKOUT?.trim()
        ? path.resolve(env.LINGER_CHECKOUT.trim())
        : undefined;

  let localmodels = null;
  if (options.localmodels) {
    const moduleDir = path.resolve(options.localmodels);
    if (!exists(path.join(moduleDir, "localmodels")))
      throw new Error(
        `--localmodels must point to an llm-inference-lab checkout containing localmodels/: ${moduleDir}`,
      );
    const python = resolveLocalmodelsPython(
      moduleDir,
      options.localmodelsPython,
      { exists, platform, findOnPath },
    );
    localmodels = { python, moduleDir };
  } else if (
    env.LINGER_LOCALMODELS_DEV_PYTHON?.trim() &&
    env.LINGER_LOCALMODELS_DEV_MODULE_DIR?.trim()
  ) {
    localmodels = {
      python: path.resolve(env.LINGER_LOCALMODELS_DEV_PYTHON.trim()),
      moduleDir: path.resolve(env.LINGER_LOCALMODELS_DEV_MODULE_DIR.trim()),
    };
  } else if (options.localmodelsPython) {
    throw new Error("--localmodels-python requires --localmodels <dir>.");
  }

  const debug = options.debug ?? (env.LOCALMODELS_DEBUG?.trim() || undefined);
  const mode = serverUrl ? "server" : checkout ? "quick-install" : "default";

  const electronEnv = {
    ...env,
    LINGER_DESKTOP_USER_DATA: userData,
    LINGER_HOME: home,
  };
  if (serverUrl) electronEnv.LINGER_SERVER_URL = serverUrl;
  else delete electronEnv.LINGER_SERVER_URL;
  if (checkout) electronEnv.LINGER_CHECKOUT = checkout;
  else delete electronEnv.LINGER_CHECKOUT;
  if (localmodels) {
    electronEnv.LINGER_LOCALMODELS_DEV_PYTHON = localmodels.python;
    electronEnv.LINGER_LOCALMODELS_DEV_MODULE_DIR = localmodels.moduleDir;
  }
  if (debug) electronEnv.LOCALMODELS_DEBUG = debug;

  return {
    mode,
    profile: options.profile,
    profileRoot,
    userData,
    home,
    serverUrl: serverUrl ?? null,
    checkout: checkout ?? null,
    localmodels,
    debug: debug ?? null,
    hostTarget: `${platform}-${arch}`,
    watch: options.watch,
    reset: options.reset,
    skipDaemon: options.skipDaemon,
    withComputerTools: options.withComputerTools,
    electronArgs: options.electronArgs,
    electronEnv,
  };
}

const IGNORED_SEGMENTS = new Set([
  "dist",
  "node_modules",
  ".git",
  "coverage",
  "test-results",
]);

/**
 * Classifies a file change under a watched tree into a rebuild target, or null
 * when the path is a test, build output, or editor temporary file.
 */
export function classifyWatchEvent(area, filename) {
  if (!filename) return null;
  const normalized = String(filename).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return null;
  const base = segments.at(-1);
  if (
    !base ||
    base.startsWith(".#") ||
    base.endsWith("~") ||
    base.endsWith(".swp") ||
    base.endsWith(".tmp")
  )
    return null;

  if (area === "installer") {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return null;
    if (/\.(?:[cm]?[jt]sx?|css|html|json)$/.test(base)) return "installer";
    return null;
  }
  if (area === "daemon") {
    if (base.endsWith("_test.go")) return null;
    if (base.endsWith(".go") || base === "go.mod" || base === "go.sum")
      return "daemon";
    return null;
  }
  if (area === "teamhub-cli") {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return null;
    if (/\.(?:[cm]?[jt]sx?|json)$/.test(base)) return "teamhub-cli";
    return null;
  }
  return null;
}
