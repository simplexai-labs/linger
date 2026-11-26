import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

const wslExecutable = path.join(
  process.env.SystemRoot ?? "C:/Windows",
  "System32",
  "wsl.exe",
);
const wslAvailable =
  process.platform === "win32" &&
  spawnSync(wslExecutable, ["--exec", "/bin/true"], {
    timeout: 30_000,
    windowsHide: true,
  }).status === 0;

it.skipIf(!wslAvailable)(
  "sends a native WSL attachment and saves a native WSL output with Windows Node",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "linger teamhub wsl "));
    const wsl = (args: string[]) =>
      execFileSync(wslExecutable, ["--cd", "/tmp", "--exec", ...args], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      }).trim();
    let linuxRoot: string | undefined;
    const cli = path.join(root, "resources", "app", "dist", "teamhub-cli");
    let primaryError: unknown;
    try {
      mkdirSync(cli, { recursive: true });
      const put = (name: string, text: string) => {
        writeFileSync(path.join(cli, name), text);
      };
      put("package.json", '{"type":"module"}');
      put("token", "th_agent_fixture\n");
      put(
        "config.json",
        JSON.stringify({
          version: 1,
          default_profile: "work",
          profiles: {
            work: {
              url: "https://teamhub.example",
              token_file: "token",
              scope: { kind: "room", id: "room_example" },
            },
          },
        }),
      );
      put(
        "teamhub",
        readFileSync(path.resolve("scripts/teamhub.sh"), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      );
      buildSync({
        stdin: {
          resolveDir: process.cwd(),
          contents: FIXTURE,
        },
        bundle: true,
        format: "esm",
        platform: "node",
        outfile: path.join(cli, "teamhub.js"),
      });
      const sandbox = wsl([
        "/bin/sh",
        "-c",
        'base=$HOME; if [ -w /home ]; then base=/home; fi; mktemp -d -- "$base/linger-teamhub.XXXXXXXX"',
      ]);
      expect(sandbox).toMatch(/^\/.*linger-teamhub\.[A-Za-z0-9]{8}$/u);
      linuxRoot = sandbox;
      const attachment = sandbox + "/attachment with spaces.txt";
      const alias = sandbox + "/alias.txt";
      const output = sandbox + "/output with spaces.png";
      const body = sandbox + "/body with spaces.md";
      const content = "/home/u/x.png is message text, including --attach";
      wsl([
        "/bin/sh",
        "-c",
        'printf "attachment bytes" > "$1" && ln -s -- "$1" "$2" && printf "%s" "$4" > "$3"',
        "sh",
        attachment,
        alias,
        body,
        content,
      ]);
      const launcher = wsl(["wslpath", "-u", path.join(cli, "teamhub")]);
      const node = wsl(["wslpath", "-u", process.execPath]);
      const run = (...args: string[]) =>
        JSON.parse(
          wsl(["env", `LINGER_NODE=${node}`, "/bin/sh", launcher, ...args]),
        );
      const send = (...args: string[]) =>
        run("message", "send", "--content", content, ...args);
      const receipt = {
        node: "1",
        exit: 0,
        calls: [
          {
            segments: [{ type: "text", content }, { type: "document" }],
            attachment: "attachment bytes",
          },
        ],
      };
      for (const sent of [
        send("--attach", attachment),
        run(
          "message",
          "send",
          "--message",
          JSON.stringify({
            segments: [
              { type: "text", content },
              { type: "document", "content-path": attachment },
            ],
          }),
        ),
        run(
          "message",
          "send",
          "--file",
          body,
          "--attach=" + wsl(["wslpath", "-w", attachment]),
        ),
      ]) {
        expect(sent.exit, JSON.stringify(sent)).toBe(0);
        expect(sent).toMatchObject(receipt);
      }
      const rejected = send("--attach=" + alias);
      expect(rejected.exit, JSON.stringify(rejected)).not.toBe(0);
      expect(rejected.calls).toEqual([]);
      const saved = run(
        "docs",
        "image",
        "get",
        "document_example",
        "block_card",
        "--output",
        output,
      );
      expect(saved.exit, JSON.stringify(saved)).toBe(0);
      expect(wsl(["cat", output])).toBe("image fixture");
      const linuxConfig = wsl(["wslpath", "-u", path.join(cli, "config.json")]);
      const forwarded = JSON.parse(
        wsl([
          "env",
          `LINGER_NODE=${node}`,
          `TEAMHUB_CONFIG=${linuxConfig}`,
          "TEAMHUB_PROFILE=work",
          "/bin/sh",
          launcher,
          "message",
          "send",
          "--content",
          content,
          "--attach",
          attachment,
        ]),
      );
      expect(forwarded.exit, JSON.stringify(forwarded)).toBe(0);
      expect(forwarded.teamhubConfig).toBe(path.join(cli, "config.json"));
      expect(forwarded.teamhubProfile).toBe("work");
    } catch (error) {
      primaryError = error;
    }
    try {
      if (linuxRoot)
        wsl([
          "/bin/sh",
          "-c",
          'rm -f -- "$1/attachment with spaces.txt" "$1/alias.txt" "$1/output with spaces.png" "$1/body with spaces.md" && rmdir -- "$1"',
          "sh",
          linuxRoot,
        ]);
      rmSync(root, { recursive: true, force: true, maxRetries: 8 });
    } catch (cleanupError) {
      throw primaryError === undefined
        ? cleanupError
        : new AggregateError(
            [primaryError, cleanupError],
            String(primaryError),
          );
    }
    if (primaryError !== undefined) throw primaryError;
  },
  180_000,
);

const FIXTURE = `
import { runCli } from "../teamhub-cli/src/cli.ts";
import path from "node:path";
const calls = [];
const configured = {
  WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
  SystemRoot: process.env.SystemRoot,
  TEAMHUB_CONFIG: process.env.TEAMHUB_CONFIG || path.join(path.dirname(process.argv[1]), "config.json"),
  ...(process.env.TEAMHUB_PROFILE ? { TEAMHUB_PROFILE: process.env.TEAMHUB_PROFILE } : {}),
};
let stdout = "", stderr = "";
const exit = await runCli(process.argv.slice(2), {
  cwd: process.cwd(), env: configured,
  stdout(value) { stdout += value; }, stderr(value) { stderr += value; },
  async fetch(input, init) {
    const request = new Request(input, init);
    const fields = new URL(request.url).pathname;
    if (fields.endsWith("/files/document_example/content"))
      return Response.json({ blocks: [{ id: "block_card", type: "image", props: { url: "document-asset:asset_example" } }] });
    if (fields.endsWith("/assets/asset_example/content")) return new Response("image fixture");
    const form = await request.formData();
    const metadata = JSON.parse(form.get("metadata"));
    const uploaded = form.get("file");
    calls.push({ segments: metadata.segments, attachment: await uploaded.text() });
    return Response.json({ accepted: true, target: { type: "room", id: "room_example" }, inbox_id: "room_example", message_id: "message_example", resources: [{kind: "document", segment_index: 1, status: "published", document_id: "document_example", version_id: "version_example", name: "attachment with spaces.txt"}], duplicate_request: false });
  },
});
process.stdout.write(JSON.stringify({ exit, node: process.env.ELECTRON_RUN_AS_NODE, teamhubConfig: process.env.TEAMHUB_CONFIG, teamhubProfile: process.env.TEAMHUB_PROFILE, calls, stdout, stderr }));
`;

it.skipIf(process.platform === "win32")(
  "translates Linux TEAMHUB_CONFIG and forwards WSLENV safely in teamhub.sh",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "linger-teamhub-sh-"));
    try {
      const cliDir = path.join(root, "resources", "app", "dist", "teamhub-cli");
      const binDir = path.join(root, "bin");
      const workDir = path.join(root, "cwd");
      mkdirSync(cliDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      // File matching FOO* in cwd catches accidental glob expansion of WSLENV.
      writeFileSync(path.join(workDir, "FOO_EXPANDED"), "glob trap");

      const launcher = path.join(cliDir, "teamhub.sh");
      writeFileSync(
        launcher,
        readFileSync(path.resolve("scripts/teamhub.sh"), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      );
      chmodSync(launcher, 0o700);
      writeFileSync(path.join(cliDir, "teamhub.js"), "// fixture\n");

      const fakeExe = path.join(root, "Linger.exe");
      writeFileSync(
        fakeExe,
        `#!/bin/sh
exec ${JSON.stringify(process.execPath)} -e '
  process.stdout.write(JSON.stringify({
    argv: process.argv.slice(1),
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
    WSLENV: process.env.WSLENV ?? null,
    hasConfig: Object.prototype.hasOwnProperty.call(process.env, "TEAMHUB_CONFIG"),
    TEAMHUB_CONFIG: process.env.TEAMHUB_CONFIG ?? null,
    hasProfile: Object.prototype.hasOwnProperty.call(process.env, "TEAMHUB_PROFILE"),
    TEAMHUB_PROFILE: process.env.TEAMHUB_PROFILE ?? null,
  }));
' -- "$@"
`,
      );
      chmodSync(fakeExe, 0o700);

      const wslpathLog = path.join(root, "wslpath.log");
      const fakeWslpath = path.join(binDir, "wslpath");
      writeFileSync(
        fakeWslpath,
        `#!/bin/sh
printf '%s\\n' "$2" >> ${JSON.stringify(wslpathLog)}
case "$2" in
  /mnt/c/*)
    rest=\${2#/mnt/c/}
    printf 'C:\\%s\\n' "$(printf '%s' "$rest" | tr '/' '\\\\')"
    ;;
  *)
    printf 'W:%s\\n' "$2"
    ;;
esac
`,
      );
      chmodSync(fakeWslpath, 0o700);

      const invoke = (extraEnv: Record<string, string>) => {
        writeFileSync(wslpathLog, "");
        const stdout = execFileSync("/bin/sh", [launcher, "message", "list"], {
          cwd: workDir,
          encoding: "utf8",
          env: {
            PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            ...extraEnv,
          },
        });
        const calls = readFileSync(wslpathLog, "utf8")
          .split("\n")
          .filter(Boolean);
        return {
          result: JSON.parse(stdout) as {
            argv: string[];
            ELECTRON_RUN_AS_NODE: string | null;
            WSLENV: string | null;
            hasConfig: boolean;
            TEAMHUB_CONFIG: string | null;
            hasProfile: boolean;
            TEAMHUB_PROFILE: string | null;
          },
          wslpathCalls: calls,
        };
      };

      // 1. Linux TEAMHUB_CONFIG + TEAMHUB_PROFILE + existing WSLENV with duplicates.
      const linuxCase = invoke({
        TEAMHUB_CONFIG: "/mnt/c/work/config.json",
        TEAMHUB_PROFILE: "runtime",
        WSLENV: "FOO/u:TEAMHUB_CONFIG/p:TEAMHUB_PROFILE",
      });
      expect(linuxCase.result.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(linuxCase.result.TEAMHUB_CONFIG).toBe("C:\\work\\config.json");
      expect(linuxCase.result.TEAMHUB_PROFILE).toBe("runtime");
      expect(linuxCase.result.WSLENV).toBe(
        "FOO/u:ELECTRON_RUN_AS_NODE:WSL_DISTRO_NAME:TEAMHUB_CONFIG:TEAMHUB_PROFILE",
      );
      expect(linuxCase.wslpathCalls).toHaveLength(2);
      expect(linuxCase.wslpathCalls[1]).toBe("/mnt/c/work/config.json");

      // 2. Windows drive path and UNC path skip wslpath -w on TEAMHUB_CONFIG.
      for (const winPath of [
        "C:\\Users\\alice\\config.json",
        "C:/Users/alice/config.json",
        "\\\\wsl.localhost\\Ubuntu\\home\\u\\config.json",
      ]) {
        const winCase = invoke({
          TEAMHUB_CONFIG: winPath,
          TEAMHUB_PROFILE: "runtime",
        });
        expect(winCase.result.TEAMHUB_CONFIG).toBe(winPath);
        expect(winCase.result.WSLENV).toBe(
          "ELECTRON_RUN_AS_NODE:WSL_DISTRO_NAME:TEAMHUB_CONFIG:TEAMHUB_PROFILE",
        );
        expect(winCase.wslpathCalls).toEqual([path.join(cliDir, "teamhub.js")]);
      }

      // 3. Unset TEAMHUB_CONFIG and TEAMHUB_PROFILE are not exported and clear stale WSLENV entries.
      const unsetCase = invoke({
        WSLENV: "FOO/u:TEAMHUB_CONFIG/p:TEAMHUB_PROFILE",
      });
      expect(unsetCase.result.hasConfig).toBe(false);
      expect(unsetCase.result.hasProfile).toBe(false);
      expect(unsetCase.result.WSLENV).toBe(
        "FOO/u:ELECTRON_RUN_AS_NODE:WSL_DISTRO_NAME",
      );

      // 4. Empty TEAMHUB_CONFIG and TEAMHUB_PROFILE are unset and cleared from WSLENV.
      const emptyCase = invoke({
        TEAMHUB_CONFIG: "",
        TEAMHUB_PROFILE: "",
        WSLENV: "FOO/u:TEAMHUB_CONFIG/p:TEAMHUB_PROFILE",
      });
      expect(emptyCase.result.hasConfig).toBe(false);
      expect(emptyCase.result.hasProfile).toBe(false);
      expect(emptyCase.result.WSLENV).toBe(
        "FOO/u:ELECTRON_RUN_AS_NODE:WSL_DISTRO_NAME",
      );

      // 5. Glob characters in WSLENV are preserved literally without expansion.
      const globCase = invoke({
        WSLENV: "FOO*:BAR/u",
      });
      expect(globCase.result.WSLENV).toBe(
        "FOO*:BAR/u:ELECTRON_RUN_AS_NODE:WSL_DISTRO_NAME",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
