import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openResumeLog, resumeLogFile } from "./resume-log.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), "linger-resume-log-"));
  roots.push(root);
  return root;
}
const at = () => new Date("2026-11-24T14:26:47.000Z");

test("keeps the last resume's log, timestamped and redacted, and the one before it", async () => {
  const h = await home();
  await mkdir(path.dirname(resumeLogFile(h)), { recursive: true });
  await writeFile(resumeLogFile(h), "earlier run\n");
  const log = await openResumeLog(h, at);
  log.write(
    "localmodels stack up exited with code 2; its last error output:\nstack: the deployments on this computer no longer match this plan (x-18100 was removed)\n",
  );
  log.write("Authorization: Bearer sk-live-abc api_key=sk-secret-123");
  log.close();
  const text = await readFile(resumeLogFile(h), "utf8");
  expect(text).toBe(
    [
      "2026-11-24T14:26:47.000Z localmodels stack up exited with code 2; its last error output:",
      "2026-11-24T14:26:47.000Z stack: the deployments on this computer no longer match this plan (x-18100 was removed)",
      "2026-11-24T14:26:47.000Z Authorization: [REDACTED] api_key=[REDACTED]",
      "",
    ].join("\n"),
  );
  expect(
    await readFile(resumeLogFile(h).replace(/\.log$/, ".1.log"), "utf8"),
  ).toBe("earlier run\n");
  if (process.platform !== "win32")
    expect((await stat(resumeLogFile(h))).mode & 0o777).toBe(0o600);
});

test("stops writing past its size cap", async () => {
  const h = await home();
  const log = await openResumeLog(h, at, 200);
  for (let i = 0; i < 20; i += 1) log.write(`line ${i} ${"x".repeat(40)}`);
  log.close();
  const text = await readFile(resumeLogFile(h), "utf8");
  expect(text.endsWith("[resume log truncated at 200 bytes]\n")).toBe(true);
  expect(Buffer.byteLength(text)).toBeLessThan(200 + 64);
});

test("never fails the resume when the log cannot be written", async () => {
  const h = await home();
  // A file where the installer folder should be makes the log unwritable.
  await writeFile(path.join(h, "installer"), "not a folder");
  const log = await openResumeLog(h, at);
  expect(() => log.write("still resuming")).not.toThrow();
  expect(() => log.close()).not.toThrow();
});
