import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localmodelsToolFromEnvironment } from "@linger/local-installation/localmodels-computer";

import {
  applyDevLocalmodelsEnvironment,
  ensureDevLocalmodelsDirectories,
  readDevLocalmodelsOverride,
} from "./dev-localmodels.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("readDevLocalmodelsOverride", () => {
  it("returns undefined when neither override variable is set", () => {
    expect(readDevLocalmodelsOverride({}, "/tmp/dev-home")).toBeUndefined();
    expect(
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: "  ",
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "",
        },
        "/tmp/dev-home",
      ),
    ).toBeUndefined();
  });

  it("rejects partial or relative override paths", () => {
    expect(() =>
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: "/opt/venv/bin/python",
        },
        "/tmp/dev-home",
      ),
    ).toThrow(/set together/i);
    expect(() =>
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "/src/llm-inference-lab",
        },
        "/tmp/dev-home",
      ),
    ).toThrow(/set together/i);
    expect(() =>
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: "python3",
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "/src/llm-inference-lab",
        },
        "/tmp/dev-home",
      ),
    ).toThrow(/absolute paths/i);
  });

  it("reads absolute POSIX and Windows paths with installer layout directories", () => {
    expect(
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: " /opt/venv/bin/python ",
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "/src/llm-inference-lab",
        },
        "/tmp/dev-home",
        path.posix,
      ),
    ).toEqual({
      python: "/opt/venv/bin/python",
      moduleDirectory: "/src/llm-inference-lab",
      stateDirectory: "/tmp/dev-home/runtime/localmodels/state",
      baseDirectory: "/tmp/dev-home/runtime/localmodels/models",
    });

    expect(
      readDevLocalmodelsOverride(
        {
          LINGER_LOCALMODELS_DEV_PYTHON: "C:\\lab\\.venv\\Scripts\\python.exe",
          LINGER_LOCALMODELS_DEV_MODULE_DIR: "C:\\lab",
        },
        "C:\\dev-home",
        path.win32,
      ),
    ).toEqual({
      python: "C:\\lab\\.venv\\Scripts\\python.exe",
      moduleDirectory: "C:\\lab",
      stateDirectory: "C:\\dev-home\\runtime\\localmodels\\state",
      baseDirectory: "C:\\dev-home\\runtime\\localmodels\\models",
    });
  });
});

describe("applyDevLocalmodelsEnvironment", () => {
  it("uses resolved override directories when connecting without Quick Install", () => {
    const result = applyDevLocalmodelsEnvironment(
      { HOME: "/home/dev", LOCALMODELS_DEBUG: "simulate" },
      {
        python: "/src/lab/.venv/bin/python",
        moduleDirectory: "/src/lab",
        stateDirectory: "/tmp/dev-home/runtime/localmodels/state",
        baseDirectory: "/tmp/dev-home/runtime/localmodels/models",
      },
      path.posix,
    );

    expect(result.LOCALMODELS_DEBUG).toBe("simulate");
    expect(localmodelsToolFromEnvironment(result, path.posix)).toEqual({
      python: "/src/lab/.venv/bin/python",
      moduleDirectory: "/src/lab",
      stateDirectory: "/tmp/dev-home/runtime/localmodels/state",
      baseDirectory: "/tmp/dev-home/runtime/localmodels/models",
    });
  });

  it("overrides python and module directory while keeping existing install state and model directories", () => {
    const result = applyDevLocalmodelsEnvironment(
      {
        LINGER_LOCALMODELS_PYTHON: "/old/kit/python",
        LINGER_LOCALMODELS_MODULE_DIR: "/old/kit/mod",
        LINGER_LOCALMODELS_STATE: "/custom/home/runtime/localmodels/state",
        LINGER_LOCALMODELS_BASE_DIR: "/custom/home/runtime/localmodels/models",
      },
      {
        python: "/src/lab/.venv/bin/python",
        moduleDirectory: "/src/lab",
        stateDirectory: "/default/home/runtime/localmodels/state",
        baseDirectory: "/default/home/runtime/localmodels/models",
      },
      path.posix,
    );

    expect(localmodelsToolFromEnvironment(result, path.posix)).toEqual({
      python: "/src/lab/.venv/bin/python",
      moduleDirectory: "/src/lab",
      stateDirectory: "/custom/home/runtime/localmodels/state",
      baseDirectory: "/custom/home/runtime/localmodels/models",
    });
  });

  it("creates private state and models directories when ensuring dev directories", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-localmodels-"));
    roots.push(root);
    const override = readDevLocalmodelsOverride(
      {
        LINGER_LOCALMODELS_DEV_PYTHON: path.join(root, "python"),
        LINGER_LOCALMODELS_DEV_MODULE_DIR: root,
      },
      path.join(root, "home"),
    );
    const env = applyDevLocalmodelsEnvironment({}, override);
    await ensureDevLocalmodelsDirectories(env);
    const stateDir = path.join(root, "home", "runtime", "localmodels", "state");
    const modelsDir = path.join(
      root,
      "home",
      "runtime",
      "localmodels",
      "models",
    );
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(modelsDir)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(statSync(modelsDir).mode & 0o777).toBe(0o700);
    }
  });
});
