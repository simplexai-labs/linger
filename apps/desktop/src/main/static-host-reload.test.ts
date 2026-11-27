import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStaticHost } from "../../../web/static-host.mjs";

const tempDirs: string[] = [];
const servers: Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("apps/web/static-host.mjs V2 zero-downtime hot reload", () => {
  it("hot-swaps static root with token auth, rejects unauthorized/escape requests, and keeps server alive", async () => {
    const storeWeb = await makeTempDir("linger-web-store-");
    const outsideDir = await makeTempDir("linger-web-outside-");
    const v1Root = path.join(storeWeb, "web-111111111111", "dist");
    const v2Root = path.join(storeWeb, "web-222222222222", "dist");
    await mkdir(v1Root, { recursive: true });
    await mkdir(v2Root, { recursive: true });
    await writeFile(
      path.join(v1Root, "index.html"),
      "<html>v1-ui</html>",
      "utf8",
    );
    await writeFile(
      path.join(v2Root, "index.html"),
      "<html>v2-ui</html>",
      "utf8",
    );
    await writeFile(
      path.join(outsideDir, "index.html"),
      "<html>evil</html>",
      "utf8",
    );

    const controlToken = "secret-control-token-32bytes-hex";
    const handler = createStaticHost({
      root: v1Root,
      controlToken,
      allowedStaticRoot: storeWeb,
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    // 1. Serves v1 initially
    const res1 = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe("<html>v1-ui</html>");

    // 2. Rejects missing/invalid control token (401)
    const unauth = await fetch(`${base}/__internal/reload-static`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: v2Root }),
    });
    expect(unauth.status).toBe(401);

    // 3. Rejects target root outside allowedStaticRoot (403)
    const escape = await fetch(`${base}/__internal/reload-static`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linger-control-token": controlToken,
      },
      body: JSON.stringify({ root: outsideDir }),
    });
    expect(escape.status).toBe(403);

    // 4. Performs authorized atomic hot-swap to v2 (200)
    const swap = await fetch(`${base}/__internal/reload-static`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linger-control-token": controlToken,
      },
      body: JSON.stringify({ root: v2Root, artifactId: "web-222222222222" }),
    });
    expect(swap.status).toBe(200);
    const swapJson = (await swap.json()) as { ok: boolean; artifactId: string };
    expect(swapJson.ok).toBe(true);
    expect(swapJson.artifactId).toBe("web-222222222222");

    // 5. Immediately serves v2 & reports new artifactId on /healthz with zero restart
    const res2 = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(await res2.text()).toBe("<html>v2-ui</html>");
    const health = (await (await fetch(`${base}/healthz`)).json()) as {
      ok: boolean;
      artifactId: string;
    };
    expect(health.ok).toBe(true);
    expect(health.artifactId).toBe("web-222222222222");
  });

  it.skipIf(process.platform === "win32")(
    "accepts symlinked allowedStaticRoot/root paths (e.g. macOS /tmp -> /private/tmp) while blocking symlink escapes",
    async () => {
      const root = await makeTempDir("linger-web-symlink-");
      const realHome = path.join(root, "private", "tmp", "home");
      const linkHome = path.join(root, "tmp-link");
      const storeWebReal = path.join(realHome, "store", "web");
      const v1Root = path.join(storeWebReal, "web-1111", "dist");
      const v2Root = path.join(storeWebReal, "web-2222", "dist");
      const outside = path.join(root, "outside");
      await mkdir(v1Root, { recursive: true });
      await mkdir(v2Root, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(
        path.join(v1Root, "index.html"),
        "<html>v1</html>",
        "utf8",
      );
      await writeFile(
        path.join(v2Root, "index.html"),
        "<html>v2-symlink</html>",
        "utf8",
      );
      await writeFile(
        path.join(outside, "index.html"),
        "<html>escape</html>",
        "utf8",
      );
      await symlink(realHome, linkHome);
      const escapeLink = path.join(storeWebReal, "escape-link");
      await symlink(outside, escapeLink);

      const controlToken = "symlink-test-token-24bytes";
      // Configure allowedStaticRoot via symlink path (like /tmp/home/store/web)
      // while sending realpath in body.root (and vice versa).
      const handler = createStaticHost({
        root: v1Root,
        controlToken,
        allowedStaticRoot: path.join(linkHome, "store", "web"),
      });
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;

      // Symlink escape inside store/web pointing outside must be rejected (403).
      const escapeRes = await fetch(`${base}/__internal/reload-static`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-linger-control-token": controlToken,
        },
        body: JSON.stringify({ root: escapeLink }),
      });
      expect(escapeRes.status).toBe(403);

      // Realpath matching symlinked allowedStaticRoot succeeds (200).
      const swapRes = await fetch(`${base}/__internal/reload-static`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-linger-control-token": controlToken,
        },
        body: JSON.stringify({
          root: await realpath(v2Root),
          artifactId: "web-2222",
        }),
      });
      expect(swapRes.status).toBe(200);
      const page = await fetch(`${base}/`, {
        headers: { accept: "text/html" },
      });
      expect(await page.text()).toBe("<html>v2-symlink</html>");
    },
  );
});
