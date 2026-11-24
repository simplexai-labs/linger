import {
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  MAX_LOCALMODELS_BYTES,
  MAX_LOCALMODELS_FILES,
  collectDiagnostics,
  diagnosticsEntry,
  excludedFromDiagnostics,
  homeRedactor,
  redactDiagnostics,
} from "./diagnostics.js";
import { tempDirectory } from "./test-support.js";

// Reads every entry of a zip through its central directory.
const unzip = (file: string): Map<string, string> => {
  const zip = readFileSync(file);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    entries.set(
      name,
      (method === 8 ? inflateRawSync(data) : data).toString("utf8"),
    );
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("excludedFromDiagnostics", () => {
  it.each([
    "C:\\Users\\me\\.linger\\instances\\desktop\\computer\\Gateway.JSON",
    "C:\\Users\\me\\.linger\\instances\\desktop\\caller.key",
    "C:\\Users\\me\\.linger\\instances\\desktop\\control.key",
    "C:\\Users\\me\\.linger\\instances\\desktop\\compose.env",
    "C:\\Users\\me\\.linger\\instances\\desktop\\launch.html",
    "C:\\Users\\me\\.linger\\installer\\jobs\\job_1.input.json",
    "C:\\Users\\me\\AppData\\Roaming\\Linger\\computer\\credential.json",
    "C:\\Users\\me\\AppData\\Roaming\\Linger\\Network\\Cookies",
    "/home/me/.linger/instances/desktop/.env.local",
    "/home/me/.linger/instances/desktop/postgres-password",
    "/home/me/.linger/runtime/localmodels/state/byok.json",
    "/home/me/.linger/runtime/localmodels/models/deployments/llm/api-key",
  ])("leaves out %s", (file) => {
    expect(excludedFromDiagnostics(file)).toBe(true);
  });

  it.each([
    "C:\\Users\\me\\.linger\\installer\\jobs\\job_1.json",
    "C:\\Users\\me\\AppData\\Roaming\\Linger\\logs\\computer-daemon.log",
    "/home/me/.linger/instances/desktop/instance.json",
  ])("keeps %s", (file) => {
    expect(excludedFromDiagnostics(file)).toBe(false);
  });
});

describe("diagnosticsEntry", () => {
  it("names Windows files with forward slashes below the prefix", () => {
    expect(
      diagnosticsEntry(
        "linger-home",
        "C:\\Users\\me\\.linger",
        "C:\\Users\\me\\.linger\\installer\\jobs\\job_1.json",
        path.win32,
      ),
    ).toBe("linger-home/installer/jobs/job_1.json");
  });
});

describe("redactDiagnostics", () => {
  it("hides tokens, passwords and bearer credentials", () => {
    const text = redactDiagnostics(
      [
        '{"accessToken": "abc123", "db_password": "hunter2", "name": "kept"}',
        "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      ].join("\n"),
    );
    expect(text).not.toMatch(/abc123|hunter2|eyJhbGciOiJIUzI1NiJ9/);
    expect(text).toContain('"name": "kept"');
  });
});

describe("homeRedactor", () => {
  it("replaces a macOS or Linux home folder with ~", () => {
    const strip = homeRedactor("/Users/alice/");
    expect(strip("open /Users/alice/.linger/x.log and /Users/alice")).toBe(
      "open ~/.linger/x.log and ~",
    );
    // Another account whose name starts the same stays.
    expect(strip("/Users/alice2/notes")).toBe("/Users/alice2/notes");
  });

  it("replaces a Windows home in every form a log prints it", () => {
    const strip = homeRedactor("C:\\Users\\Alice");
    expect(
      strip(
        [
          "C:\\Users\\Alice\\.linger\\job.log",
          '{"path":"C:\\\\Users\\\\Alice\\\\.linger"}',
          "c:/users/alice/AppData",
        ].join("\n"),
      ),
    ).toBe(
      ["~\\.linger\\job.log", '{"path":"~\\\\.linger"}', "~/AppData"].join(
        "\n",
      ),
    );
  });

  it("leaves text alone for a home at the root", () => {
    expect(homeRedactor("/root")("/root/.linger")).toBe("/root/.linger");
  });
});

describe("collectDiagnostics", () => {
  it("replaces the home folder in every entry and the summary", async () => {
    const root = tempDirectory();
    const userHome = path.join(root, "people", "alice");
    const home = path.join(userHome, ".linger");
    const output = path.join(root, "out");
    mkdirSync(output);
    write(
      path.join(home, "installer", "jobs", "job_1.log"),
      `unpacking into ${path.join(home, "source")}\n`,
    );
    const { file } = await collectDiagnostics({
      userData: path.join(root, "userData"),
      homes: [home],
      output,
      summary: {},
      userHome,
    });
    const text = [...unzip(file).values()].join("\n");
    expect(text).not.toContain(userHome);
    expect(unzip(file).get("linger-home/installer/jobs/job_1.log")).toBe(
      `unpacking into ${path.join("~", ".linger", "source")}\n`,
    );
  });

  it("bundles logs and job state without credentials", async () => {
    const root = tempDirectory();
    const userData = path.join(root, "userData");
    const home = path.join(root, "home");
    const output = path.join(root, "out");
    mkdirSync(output);
    write(
      path.join(userData, "logs", "main.log"),
      'local_server.install_failed {"token":"t-secret"}\n',
    );
    write(
      path.join(userData, "logs", "computer-daemon.log"),
      "runtime.diagnostic type=codex status=authentication_required\n",
    );
    write(path.join(userData, "computer", "credential.json"), "{}");
    write(path.join(userData, "Cookies"), "cookie");
    write(
      path.join(home, "installer", "jobs", "job_1.json"),
      '{"state":"failed"}',
    );
    write(
      path.join(home, "installer", "jobs", "job_1.input.json"),
      '{"apiKey":"sk-1"}',
    );
    write(
      path.join(home, "instances", "desktop", "instance.json"),
      JSON.stringify({ mode: "source-native" }),
    );
    write(path.join(home, "instances", "desktop", "caller.key"), "key");
    write(path.join(home, "instances", "desktop", "services.env"), "A=1");
    write(
      path.join(home, "instances", "desktop", "native", "logs", "teamhub.log"),
      "another_me.create_failed\n",
    );
    write(path.join(home, "instances", "desktop", "data", "db.json"), "{}");

    const {
      file,
      entries: listed,
      bytes,
    } = await collectDiagnostics({
      userData,
      homes: [home, home],
      output,
      summary: { version: "0.16.27" },
      userHome: path.join(root, "another-user"),
      now: new Date("2026-11-06T07:08:09Z"),
    });

    expect(path.basename(file)).toBe("linger-diagnostics-20261106-070809.zip");
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    const entries = unzip(file);
    expect(bytes).toBe(statSync(file).size);
    expect([...listed].sort()).toEqual([...entries.keys()].sort());
    expect([...entries.keys()].sort()).toEqual([
      "desktop/logs/computer-daemon.log",
      "desktop/logs/main.log",
      "linger-home/installer/jobs/job_1.json",
      "linger-home/instances/desktop/instance.json",
      "linger-home/instances/desktop/native/logs/teamhub.log",
      "summary.json",
    ]);
    expect(entries.get("desktop/logs/main.log")).not.toContain("t-secret");
    expect(JSON.parse(entries.get("summary.json")!)).toMatchObject({
      version: "0.16.27",
      homes: [path.resolve(home)],
    });
  });

  it("hides saved provider keys wherever a log printed them", async () => {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const output = path.join(root, "out");
    mkdirSync(output);
    write(
      path.join(home, "instances", "desktop", "user.env"),
      "COMPOSIO_API_KEY=composio-789\nSONIOX_API_KEY=soniox-123\nXAI_API_KEY=xai-456\n",
    );
    write(
      path.join(home, "instances", "desktop", "instance.json"),
      JSON.stringify({ mode: "source-native" }),
    );
    write(
      path.join(home, "instances", "desktop", "native", "logs", "voice.log"),
      "connecting with soniox-123\nlive session key xai-456 rejected\n",
    );
    const entries = unzip(
      (
        await collectDiagnostics({
          userData: path.join(root, "userData"),
          homes: [home],
          output,
          summary: {},
        })
      ).file,
    );
    expect(entries.has("linger-home/instances/desktop/user.env")).toBe(false);
    const text = [...entries.values()].join("\n");
    expect(text).not.toContain("soniox-123");
    expect(text).not.toContain("xai-456");
    expect(text).not.toContain("composio-789");
    expect(
      entries.get("linger-home/instances/desktop/native/logs/voice.log"),
    ).toContain("live session key [REDACTED] rejected\n");
  });

  it("bundles recent localmodels stack run records, deployment records, and engine logs with redaction", async () => {
    const root = tempDirectory();
    const userHome = path.join(root, "people", "bob");
    const home = path.join(userHome, ".linger");
    const output = path.join(root, "out");
    mkdirSync(output);
    const localmodels = path.join(home, "runtime", "localmodels");
    write(
      path.join(localmodels, "state", "stacks", "abcdef123456.run.json"),
      JSON.stringify({
        schema: "localmodels.stack-run/v1",
        state: "failed",
        components: [
          {
            component: "llm",
            status: "failed",
            detail: `llama-server failed in ${home} with Authorization: Bearer lm-secret-token`,
          },
        ],
        api_key: "lm-inline-secret",
      }),
    );
    write(
      path.join(localmodels, "state", "stacks", "abcdef123456.progress"),
      JSON.stringify({ schema: "localmodels.stack-apply-progress/v1" }),
    );
    write(
      path.join(localmodels, "state", "stacks", ".apply.lock"),
      "lock-file\n",
    );
    write(
      path.join(localmodels, "state", "byok.json"),
      JSON.stringify({ api_key: "byok-secret-never-bundle" }),
    );
    write(
      path.join(localmodels, "state", "deployments", "local", "qwen-llm.json"),
      JSON.stringify({
        ok: false,
        api_key_location: path.join(
          localmodels,
          "models",
          "deployments",
          "qwen-llm",
          "api-key",
        ),
        argv: ["llama-server", "--api-key", "deployment-raw-key"],
        steps: [
          {
            step: "start",
            ok: false,
            stderr: `exec failed at ${path.join(home, "runtime")} api_key=step-secret-999`,
          },
        ],
      }),
    );
    write(
      path.join(localmodels, "models", "deployments", "qwen-llm", "server.log"),
      [
        `exec llama-server --port 8081 --api-key deployment-raw-key -m ${path.join(home, "runtime", "localmodels", "models", "m.gguf")}`,
        "Bearer server-log-secret",
        "CUDA out of memory",
        "",
      ].join("\n"),
    );
    write(
      path.join(localmodels, "models", "deployments", "qwen-llm", "api-key"),
      "deployment-raw-key\n",
    );
    write(
      path.join(localmodels, "models", "weights", "huge.gguf"),
      "gguf-bytes",
    );
    const outside = path.join(root, "outside-secret.txt");
    write(outside, "do-not-follow-symlink\n");
    if (process.platform !== "win32") {
      symlinkSync(
        outside,
        path.join(localmodels, "state", "stacks", "symlinked.run.json"),
      );
      mkdirSync(path.join(localmodels, "models", "deployments", "sym-llm"), {
        recursive: true,
      });
      symlinkSync(
        outside,
        path.join(
          localmodels,
          "models",
          "deployments",
          "sym-llm",
          "server.log",
        ),
      );
    }

    const { file } = await collectDiagnostics({
      userData: path.join(root, "userData"),
      homes: [home],
      output,
      summary: {},
      userHome,
    });
    const entries = unzip(file);
    expect([...entries.keys()].sort()).toEqual([
      "linger-home/runtime/localmodels/models/deployments/qwen-llm/server.log",
      "linger-home/runtime/localmodels/state/deployments/local/qwen-llm.json",
      "linger-home/runtime/localmodels/state/stacks/abcdef123456.progress",
      "linger-home/runtime/localmodels/state/stacks/abcdef123456.run.json",
      "summary.json",
    ]);
    const joined = [...entries.values()].join("\n");
    expect(joined).not.toContain(userHome);
    expect(joined).not.toContain("lm-secret-token");
    expect(joined).not.toContain("lm-inline-secret");
    expect(joined).not.toContain("byok-secret-never-bundle");
    expect(joined).not.toContain("step-secret-999");
    expect(joined).not.toContain("server-log-secret");
    expect(joined).not.toContain("deployment-raw-key");
    expect(
      entries.get(
        "linger-home/runtime/localmodels/models/deployments/qwen-llm/server.log",
      ),
    ).toContain("--api-key [REDACTED]");
    expect(
      entries.get(
        "linger-home/runtime/localmodels/models/deployments/qwen-llm/server.log",
      ),
    ).toContain("CUDA out of memory");
  });

  it("caps localmodels stack run file count and per-file byte size", async () => {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const output = path.join(root, "out");
    mkdirSync(output);
    const stacks = path.join(home, "runtime", "localmodels", "state", "stacks");
    const baseTime = 1_700_000_000;
    for (let index = 0; index < MAX_LOCALMODELS_FILES + 3; index++) {
      const target = path.join(stacks, `plan-${index}.run.json`);
      const body =
        index === MAX_LOCALMODELS_FILES + 2
          ? `${"a".repeat(MAX_LOCALMODELS_BYTES + 1024)}\nfinal-failure-line\n`
          : JSON.stringify({ index });
      write(target, body);
      const stamp = new Date((baseTime + index * 10) * 1000);
      utimesSync(target, stamp, stamp);
    }

    const { file } = await collectDiagnostics({
      userData: path.join(root, "userData"),
      homes: [home],
      output,
      summary: {},
    });
    const entries = unzip(file);
    const bundledRuns = [...entries.keys()]
      .filter((entry) => entry.endsWith(".run.json"))
      .sort();
    expect(bundledRuns).toHaveLength(MAX_LOCALMODELS_FILES);
    expect(bundledRuns).not.toContain(
      "linger-home/runtime/localmodels/state/stacks/plan-0.run.json",
    );
    expect(bundledRuns).not.toContain(
      "linger-home/runtime/localmodels/state/stacks/plan-1.run.json",
    );
    expect(bundledRuns).not.toContain(
      "linger-home/runtime/localmodels/state/stacks/plan-2.run.json",
    );
    const newest = entries.get(
      `linger-home/runtime/localmodels/state/stacks/plan-${MAX_LOCALMODELS_FILES + 2}.run.json`,
    )!;
    expect(newest).toMatch(/^\[first \d+ bytes left out\]\n/);
    expect(newest).toContain("final-failure-line");
    expect(Buffer.byteLength(newest, "utf8")).toBeLessThanOrEqual(
      MAX_LOCALMODELS_BYTES + 128,
    );
  });
});
