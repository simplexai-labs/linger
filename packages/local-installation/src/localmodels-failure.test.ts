import { expect, it } from "vitest";
import {
  localmodelsFailure,
  redactLocalmodelsOutput,
} from "./localmodels-failure.js";

const args = ["gateway", "ensure", "--root", "/private/root", "--jsonl"];

it("reads the cause from the JSONL error line after progress events", () => {
  const progress = JSON.stringify({
    kind: "progress",
    stage: "download",
    completed: 10,
    total: 100,
    unit: "bytes",
  });
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: [
      progress,
      progress,
      JSON.stringify({
        schema: "localmodels.gateway-error/v1",
        code: "GATEWAY_DOWNLOAD_FAILED",
        message:
          "Download of magpie-cli-darwin-arm64 from github.com failed: host name lookup failed.",
        host: "github.com",
        reason: "host name lookup failed",
      }),
    ].join("\n"),
    stderr: "",
  });
  expect(failure).toMatchObject({
    code: "GATEWAY_DOWNLOAD_FAILED",
    cause:
      "Download of magpie-cli-darwin-arm64 from github.com failed: host name lookup failed.",
  });
  const log = failure.log.join("");
  expect(log).toContain("localmodels gateway ensure exited with code 1");
  expect(log).toContain("GATEWAY_DOWNLOAD_FAILED");
  expect(log).not.toContain('"progress"');
});

it("accepts a kind error event and falls back to its reason", () => {
  expect(
    localmodelsFailure(args, {
      code: 1,
      stdout: JSON.stringify({ kind: "error", reason: "disk full" }),
      stderr: "",
    }).cause,
  ).toBe("disk full");
});

it("uses a short tail of stderr when no error line was printed", () => {
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: "",
    stderr: [
      "Traceback (most recent call last):",
      '  File "gateway_cli.py", line 279, in ensure',
      "    raise RuntimeError(...)",
      "RuntimeError: Selected runtime must be prepared before gateway ensure",
      "",
    ].join("\n"),
  });
  expect(failure.code).toBeUndefined();
  expect(failure.cause).toMatch(
    /RuntimeError: Selected runtime must be prepared before gateway ensure$/,
  );
  expect(failure.cause).not.toContain("Traceback");
  expect(failure.log.join("")).toContain("Traceback (most recent call last)");
});

it("has no cause when the process printed nothing", () => {
  expect(
    localmodelsFailure(args, { code: 143, stdout: "", stderr: "" }),
  ).toMatchObject({
    cause: undefined,
    log: ["localmodels gateway ensure exited with code 143."],
  });
});

it("redacts credentials from the cause and the log", () => {
  const secrets = [
    "Authorization: Bearer abc.def.ghi",
    "api_key=sk-ant-0123456789abcdefghij",
    "https://user:pa55word@proxy.example/x",
    "https://objects.githubusercontent.com/a/b?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA",
    "token: ghp_0123456789abcdefghijklmn",
    "plain sk-proj-0123456789abcdefghij",
    "9git+https://user:hunter22@git.example/x",
  ];
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: JSON.stringify({
      schema: "localmodels.gateway-error/v1",
      code: "GATEWAY_DOWNLOAD_FAILED",
      message: `failed via ${secrets[3]} with ${secrets[0]}`,
    }),
    stderr: secrets.join("\n"),
  });
  const text = `${failure.cause}\n${failure.log.join("")}`;
  for (const value of [
    "abc.def.ghi",
    "sk-ant-0123456789abcdefghij",
    "pa55word",
    "deadbeef",
    "AKIA",
    "ghp_0123456789abcdefghijklmn",
    "sk-proj-0123456789abcdefghij",
    "hunter22",
  ])
    expect(text).not.toContain(value);
  expect(failure.cause).toContain(
    "https://objects.githubusercontent.com/a/b?[REDACTED]",
  );
  expect(redactLocalmodelsOutput("a\u0007b\u001b[31mc")).toBe("abc");
});

it("redacts URL credentials after long alphanumeric runs in linear time", () => {
  // Hex digests and base64 alternate letters and digits; a pattern that may
  // start at every letter of such a run takes about a second on this input.
  const run = "a1".repeat(20_000);
  const started = performance.now();
  expect(redactLocalmodelsOutput(`${run} ${run}https://u:p@h/x`)).toBe(
    `${run} ${run}https://[REDACTED]@h/x`,
  );
  expect(performance.now() - started).toBeLessThan(250);
});

it("keeps the end of long output within bounded log events", () => {
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: "",
    stderr: `${"x".repeat(40_000)}\nfinal cause`,
  });
  expect(failure.log.length).toBeLessThanOrEqual(9);
  expect(failure.log.every((part) => part.length <= 1800)).toBe(true);
  expect(failure.log[1]).toBe("[earlier output omitted]");
  expect(failure.log.at(-1)).toMatch(/final cause$/);
  expect(failure.cause).toMatch(/final cause$/);
});

it("turns localmodels.stack-error/v1 JSON from uncaptured stack apply output into a readable cause and causeCode", () => {
  const stackArgs = ["stack", "apply", "/private/plan.json", "--jsonl"];
  const replan = localmodelsFailure(stackArgs, {
    code: 2,
    stdout: "",
    stderr: `${JSON.stringify({
      schema: "localmodels.stack-error/v1",
      event: "error",
      code: "STACK_APPLY_FAILED",
      category: "guard",
      causeCode: "STACK_REPLAN_FAILED",
    })}\n`,
  });
  expect(replan).toMatchObject({
    code: "STACK_APPLY_FAILED",
    causeCode: "STACK_REPLAN_FAILED",
    cause:
      "The saved local model plan no longer fits this computer's current memory or model catalog.",
  });
  expect(replan.cause).not.toContain("{");
  expect(replan.log.join("")).toContain("STACK_REPLAN_FAILED");

  const changed = localmodelsFailure(stackArgs, {
    code: 2,
    stdout: "",
    stderr: `${JSON.stringify({
      schema: "localmodels.stack-error/v1",
      event: "error",
      code: "STACK_APPLY_FAILED",
      category: "guard",
      causeCode: "STACK_PLAN_CHANGED",
      changedFields: ["llm", "budget"],
    })}\n`,
  });
  expect(changed).toMatchObject({
    code: "STACK_APPLY_FAILED",
    causeCode: "STACK_PLAN_CHANGED",
    cause:
      "This computer's state or local model runtime changed since the plan was approved (llm, budget).",
  });
});

it("turns a failed stack apply JSONL result event into a readable cause", () => {
  const failure = localmodelsFailure(["stack", "apply"], {
    code: 1,
    stdout: "",
    stderr: `${JSON.stringify({
      event: "result",
      ok: false,
      components: [
        { component: "tools", status: "ok" },
        { component: "llm", status: "failed" },
      ],
      causeCode: "STACK_COMPONENT_FAILED",
    })}\n`,
  });
  expect(failure).toMatchObject({
    code: "STACK_APPLY_FAILED",
    causeCode: "STACK_COMPONENT_FAILED",
    cause: "Local model setup failed at: llm.",
  });
});

it("turns a pretty-printed localmodels.stack-up/v1 failure report into a redacted cause", () => {
  const failure = localmodelsFailure(["stack", "up"], {
    code: 1,
    stdout: JSON.stringify(
      {
        schema: "localmodels.stack-up/v1",
        plan_id: "a".repeat(64),
        ok: false,
        parts: [
          {
            name: "spark-x2.6-1.7b-18100",
            task: "chat",
            action: "failed",
            state: "inactive",
            health: "down",
            detail:
              "failed with token=sk-ant-0123456789abcdefghij while starting",
          },
        ],
        gateway: "started",
        notes: [],
      },
      null,
      1,
    ),
    stderr: "",
  });
  expect(failure.code).toBe("STACK_UP_FAILED");
  expect(failure.cause).toContain("spark-x2.6-1.7b-18100:");
  expect(failure.cause).not.toContain("sk-ant-0123456789abcdefghij");
  expect(failure.cause).not.toContain('"schema"');
});
