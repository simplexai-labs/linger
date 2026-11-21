import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreByokSource } from "../src/local-models.ts";
import {
  ensureLocalmodelsTool,
  runLocalmodels,
} from "../src/localmodels-tool.ts";
import { privateDirectory } from "../src/private-files.ts";
import { freePort } from "../src/ports.ts";

test("the pinned kit restores the saved route before the upstream comes back", async () => {
  const distribution = new URL(
    `../../../apps/desktop/distribution/${process.platform}-${process.arch}.json`,
    import.meta.url,
  );
  const { localmodelsTool } = JSON.parse(await readFile(distribution, "utf8"));
  // Windows runner temp folders can have shared ancestors; use the user profile.
  const parent =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA
      : await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "byok-restore-"));
  const upstream = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    } else if (request.url === "/v1/chat/completions") {
      response.end(
        JSON.stringify({
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "recovered" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    } else {
      response.writeHead(404).end();
    }
  });

  const command = async (args, options) => {
    const result = await runLocalmodels(root, args, {
      timeoutMs: 180_000,
      ...options,
    });
    assert.equal(result.code, 0, result.stdout || result.stderr);
    return result.stdout;
  };
  let kitReady = false;
  try {
    await privateDirectory(root);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;
    const addr = `127.0.0.1:${await freePort(new Set([upstreamPort]))}`;
    // Keep the kit, its Bifrost process and any service-manager discovery in this test home.
    Object.assign(process.env, {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      LINGER_LOCALMODELS_TOOL_JSON: JSON.stringify(localmodelsTool),
      LOCALMODELS_TOOLS_DIR: path.join(root, "tools"),
      LOCALMODELS_BIFROST_DIR: path.join(root, "bifrost"),
      LOCALMODELS_BIFROST_ADDR: addr,
      SIMPLEX_REGION: "global",
    });
    delete process.env.LINGER_LOCALMODELS_DEV_PYTHON;
    delete process.env.LINGER_LOCALMODELS_DEV_MODULE_DIR;
    await ensureLocalmodelsTool(root);
    kitReady = true;
    const args = [
      "source",
      "apply",
      "--mode",
      "byok",
      "--runtime",
      "pi",
      "--base-dir",
      path.join(root, "models"),
      "--json",
    ];
    await command([...args, "--config-stdin"], {
      input: JSON.stringify({
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        path: "/v1",
        endpoint: "/chat/completions",
        protocol: "openai-chat",
        modelId: "test-model",
      }),
    });

    // A future kit must produce the same route and model metadata on resume as on first setup.
    const gatewayState = () =>
      Promise.all(
        ["config.json", "datasheet.json"].map(async (name) =>
          JSON.parse(await readFile(path.join(root, "bifrost", name), "utf8")),
        ),
      );
    const sourceFile = path.join(
      root,
      "runtime/localmodels/state/model-source.json",
    );
    const saved = JSON.parse(await readFile(sourceFile, "utf8"));
    const profileFiles = ["models.json", "settings.json"].map((name) =>
      path.join(saved.environment.PI_CODING_AGENT_DIR, name),
    );
    const readProfiles = () =>
      Promise.all(profileFiles.map((file) => readFile(file)));
    const configuredProfiles = await readProfiles();
    const configured = await gatewayState();
    await command(["stack", "down", "--json"]);
    await upstream[Symbol.asyncDispose]();
    const gateway = `http://${addr}`;
    await assert.rejects(fetch(`${gateway}/health`));
    const options = { signal: AbortSignal.timeout(120_000), onEvent() {} };
    assert.equal(await restoreByokSource(root, options), undefined);
    assert.equal((await fetch(`${gateway}/health`)).status, 200);
    assert.deepEqual(await gatewayState(), configured);

    await Promise.all(profileFiles.map((file) => rm(file)));
    assert.equal(await restoreByokSource(root, options), undefined);
    assert.deepEqual(await readProfiles(), configuredProfiles);

    upstream.listen(upstreamPort, "127.0.0.1");
    await once(upstream, "listening");
    const response = await fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "localmodels-byok",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      (await response.json()).choices[0].message.content,
      "recovered",
    );
    // The daemon can change the source after Desktop has already read it.
    await writeFile(
      sourceFile,
      JSON.stringify({ ...saved, mode: "subscription" }),
    );
    assert.deepEqual(
      JSON.parse(await command(args, { restoreSavedByok: true })),
      { restore: "skipped" },
    );
    assert.equal(
      JSON.parse(await readFile(sourceFile, "utf8")).mode,
      "subscription",
    );
    await rm(sourceFile);
    const missing = await runLocalmodels(root, args, {
      restoreSavedByok: true,
    });
    assert.notEqual(missing.code, 0);
    assert.equal(JSON.parse(missing.stdout).code, "BYOK_INVALID_CONFIG");
  } finally {
    try {
      if (kitReady) await command(["stack", "down", "--json"]);
    } finally {
      await upstream[Symbol.asyncDispose]();
      // The verified kit seals its cache directories read-only on Unix.
      if (process.platform !== "win32")
        execFileSync("chmod", ["-R", "u+rwX", root]);
      await rm(root, { recursive: true, force: true });
    }
  }
});
