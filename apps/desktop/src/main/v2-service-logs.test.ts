import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFailedServiceLogReader,
  probeNameToServiceLog,
  readSanitizedLogTail,
  redactServiceLogText,
} from "./v2-service-logs.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v2-service-logs", () => {
  it("maps known health probes to native service log names and ignores unknown probes", () => {
    expect(probeNameToServiceLog("teamhub-healthz")).toBe("teamhub");
    expect(probeNameToServiceLog("node-services-healthz")).toBe(
      "node-services",
    );
    expect(probeNameToServiceLog("web-healthz")).toBe("web");
    expect(probeNameToServiceLog("postgres-healthz")).toBe("postgres");
    expect(probeNameToServiceLog("livekit-healthz")).toBe("livekit");
    expect(probeNameToServiceLog("teamhub")).toBe("teamhub");
    expect(probeNameToServiceLog("../../etc/passwd")).toBeUndefined();
    expect(probeNameToServiceLog("unknown-probe")).toBeUndefined();
  });

  it("reads tail lines from teamhub.log under custom home, bounds >8 KiB logs, and skips missing files", async () => {
    const defaultHome = await makeTempDir("linger-svclog-default-");
    const customHome = await makeTempDir("linger-svclog-custom-");
    const logsDir = path.join(
      customHome,
      "instances",
      "desktop",
      "native",
      "logs",
    );
    await mkdir(logsDir, { recursive: true });

    // Write > 12 KiB of early noise followed by the actual failure tail.
    const fillerLines = Array.from(
      { length: 200 },
      (_, i) => `2026-11-27T06:00:00Z INFO startup line ${i} ${"x".repeat(60)}`,
    );
    const tailLines = [
      "2026-11-27T06:01:00Z INFO boot step 1",
      "",
      "[V2-TEST-FAULTY-0.1.11-v2test.3] simulated startup failure for rollback verification",
      "exit status 42",
    ];
    await writeFile(
      path.join(logsDir, "teamhub.log"),
      `${[...fillerLines, ...tailLines].join("\n")}\n`,
      "utf8",
    );

    let activeHome = defaultHome;
    const readLogs = createFailedServiceLogReader({
      getHome: () => activeHome,
    });

    // Missing log directory returns empty record cleanly.
    expect(
      await readLogs(["teamhub-healthz", "node-services-healthz"]),
    ).toEqual({});

    // Switch to custom home -> reads only teamhub.log tail, ignores missing node-services.log.
    activeHome = customHome;
    const tails = await readLogs(["teamhub-healthz", "node-services-healthz"]);
    expect(Object.keys(tails)).toEqual(["teamhub"]);
    expect(tails.teamhub).toContain(
      "[V2-TEST-FAULTY-0.1.11-v2test.3] simulated startup failure for rollback verification",
    );
    expect(tails.teamhub).toContain("exit status 42");
    expect(tails.teamhub).not.toContain("startup line 0 ");
    expect(tails.teamhub!.split("\n").length).toBeLessThanOrEqual(10);
    expect(tails.teamhub!.length).toBeLessThanOrEqual(1500);

    // Enforces maxChars cap while keeping the newest tail content.
    const longFile = path.join(logsDir, "web.log");
    await writeFile(
      longFile,
      `${"A".repeat(2000)}\nFINAL_FATAL_LINE\n`,
      "utf8",
    );
    const capped = await readSanitizedLogTail(longFile, { maxChars: 120 });
    expect(capped).toBeDefined();
    expect(capped!.length).toBeLessThanOrEqual(120);
    expect(capped).toContain("FINAL_FATAL_LINE");
  });

  it("redacts DB URLs, auth headers, cookies, env/JSON secrets, token prefixes, JWTs, and PEM blocks", () => {
    const secrets = [
      "pg_s3cr3t_pw",
      "redis_pass_99",
      "http_basic_pass",
      "bearer_tok_xyz123456",
      "dXNlcjpwYXNzMTIzNDU=",
      "session_abc=supercookie123",
      "csrf=anothercookie456",
      "my_openai_api_key_val",
      "local_identity_key_abc987",
      "pg_env_secret_777",
      "json_secret_token_888",
      "sk-proj-AbCdEfGhIjKlMnOp1234",
      "ghp_1234567890abcdefghij",
      "xoxb-1234567890-abcdef1234",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7",
    ];

    const raw = [
      "db error: postgres://simplexai:pg_s3cr3t_pw@127.0.0.1:5432/simplexai?sslmode=disable",
      "cache: redis://:redis_pass_99@127.0.0.1:6379/0 proxy=https://alice:http_basic_pass@proxy.local:8080",
      "Authorization: Bearer bearer_tok_xyz123456",
      "Authorization: Basic dXNlcjpwYXNzMTIzNDU=",
      "Cookie: session_abc=supercookie123; csrf=anothercookie456",
      "Set-Cookie: session_abc=supercookie123; HttpOnly; Secure",
      "OPENAI_API_KEY=my_openai_api_key_val TEAMHUB_LOCAL_IDENTITY_KEY=local_identity_key_abc987 PGPASSWORD=pg_env_secret_777",
      '{"accessToken": "json_secret_token_888", "level": "error"}',
      "leaked sk-proj-AbCdEfGhIjKlMnOp1234 and ghp_1234567890abcdefghij and xoxb-1234567890-abcdef1234 and AKIAIOSFODNN7EXAMPLE",
      "jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7",
      "-----END RSA PRIVATE KEY-----",
      "normal line: teamhub exited with code 42",
    ].join("\n");

    const sanitized = redactServiceLogText(raw);
    for (const secret of secrets) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).toContain("[REDACTED_PRIVATE_KEY]");
    expect(sanitized).toContain("normal line: teamhub exited with code 42");
  });
});
