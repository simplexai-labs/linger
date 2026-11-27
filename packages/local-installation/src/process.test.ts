import { expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { runProcess } from "./process.js";
it("executes argument arrays literally and preserves JSON output", async () => {
  const value = "$(touch /tmp/never-linger); a b";
  const result = await runProcess(process.execPath, [
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    value,
  ]);
  expect(JSON.parse(result.stdout)).toEqual([value]);
  expect(result.code).toBe(0);
});
it.each(["stdout", "stderr"] as const)(
  "preserves a UTF-8 character split between %s chunks",
  async (stream) => {
    const input = new PassThrough();
    const output: string[] = [];
    let continued = false;
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        `const stream = process[process.argv[1]];
const bytes = Buffer.from(JSON.stringify({path: 'file-\\u2603.txt'}));
const split = bytes.indexOf(0xe2) + 1;
process.stdin.once('data', () => stream.write(bytes.subarray(split)));
stream.write(bytes.subarray(0, split));`,
        stream,
      ],
      {
        inputStream: input,
        timeoutMs: 2_000,
        onOutput: (value) => {
          output.push(value);
          if (!continued) {
            continued = true;
            // The child sends the remaining bytes only after this chunk arrived.
            input.end("continue");
          }
        },
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result[stream])).toEqual({ path: "file-\u2603.txt" });
    expect(output.join("")).toBe(result[stream]);
    expect(result[stream === "stdout" ? "stderr" : "stdout"]).toBe("");
  },
);
it("reports nonzero exit without exposing argv in errors", async () => {
  expect(
    (await runProcess(process.execPath, ["-e", "process.exit(7)"])).code,
  ).toBe(7);
  await expect(
    runProcess("/missing-linger-private-secret", []),
  ).rejects.toMatchObject({
    code: "COMMAND_EXECUTABLE_UNAVAILABLE",
    message: "Command executable unavailable",
  });
});
it("bounds captured output rather than buffering forever", async () => {
  await expect(
    runProcess(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(3_000_000))",
    ]),
  ).rejects.toThrow(/output/i);
});
it("aborts and times out actual children", async () => {
  const controller = new AbortController();
  const child = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  await expect(child).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 30,
    }),
  ).rejects.toMatchObject({
    code: "COMMAND_TIMEOUT",
    message: "Command timed out",
  });
});
it("captures stderr separately and kills a stubborn child process group", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write('ok');process.stderr.write('diagnostic')",
  ]);
  expect(result).toEqual({ stdout: "ok", stderr: "diagnostic", code: 0 });
  const controller = new AbortController();
  let descendant = 0;
  const run = runProcess(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`,
    ],
    {
      signal: controller.signal,
      onOutput: (value) => {
        descendant = Number(value.trim());
        controller.abort();
      },
    },
  );
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() => process.kill(descendant, 0)).toThrow();
});
it("can stream long-lived output without accumulating capture buffers", async () => {
  let bytes = 0;
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(3_000_000))"],
    {
      capture: false,
      onOutput: (value) => {
        bytes += value.length;
      },
    },
  );
  expect(bytes).toBe(3_000_000);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

it("pipes private input to the child without putting it in argv, environment or output", async () => {
  const secret = "fixture-stdin-password\n";
  const output: string[] = [];
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({matched:input==='fixture-stdin-password\\n',args:process.argv.slice(1),envLeak:Object.values(process.env).includes(input.trim())})))`,
    ],
    { input: secret, onOutput: (value) => output.push(value) },
  );
  expect(JSON.parse(result.stdout)).toEqual({
    matched: true,
    args: [],
    envLeak: false,
  });
  expect(output.join("").includes(secret.trim())).toBe(false);
});
it("handles closed stdin without uncaught EPIPE or exposing private input", async () => {
  const failure = await runProcess(
    process.execPath,
    [
      "-e",
      "require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),100)",
    ],
    { input: "fixture-private-input".repeat(500_000) },
  ).then(
    () => undefined,
    (error: Error & { code?: string }) => error,
  );
  expect(failure).toMatchObject({
    code: "COMMAND_STDIN_UNAVAILABLE",
    message: "Command stdin unavailable",
  });
  expect(failure?.message).not.toContain("fixture-private-input");
});
it("cancels a child with a blocked stdin write", async () => {
  const controller = new AbortController();
  const running = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {
      input: "fixture-private-input".repeat(500_000),
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(), 30);
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
});

it("streams archive bytes into a native child without buffering them in argv", async () => {
  const { Readable } = await import("node:stream");
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "let n=0;process.stdin.on('data',x=>n+=x.length);process.stdin.on('end',()=>console.log(n))",
    ],
    { inputStream: Readable.from([Buffer.alloc(12345)]) },
  );
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("12345");
});
it("stops a silent command after the idle timeout", async () => {
  const startedAt = Date.now();
  await expect(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      idleTimeoutMs: 300,
    }),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  expect(Date.now() - startedAt).toBeLessThan(5_000);
});
it("restarts the idle timeout on every output chunk", async () => {
  const chunks: string[] = [];
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `let n = 0;
const timer = setInterval(() => {
  (n % 2 ? process.stderr : process.stdout).write("tick\\n");
  if (++n === 8) { clearInterval(timer); }
}, 100);`,
    ],
    { idleTimeoutMs: 400, onOutput: (chunk) => chunks.push(chunk) },
  );
  // 800 ms of steady output outlives a 400 ms idle timeout.
  expect(result.code).toBe(0);
  expect(chunks.join("")).toBe("tick\n".repeat(8));
});
it("times out after output stops, and the wall-clock timeout still applies", async () => {
  await expect(
    runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'); setTimeout(() => {}, 10_000)"],
      { idleTimeoutMs: 300 },
    ),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  await expect(
    runProcess(
      process.execPath,
      ["-e", "setInterval(() => process.stdout.write('x'), 50)"],
      { idleTimeoutMs: 1_000, timeoutMs: 400 },
    ),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
});
it("lets an abort win over the idle timeout and clears its timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const controller = new AbortController();
    const running = runProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10_000)"],
      { idleTimeoutMs: 60_000, signal: controller.signal },
    );
    // Observe the rejection before the timers run, so it is never unhandled.
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(600);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
