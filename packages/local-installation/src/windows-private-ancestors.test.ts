import { describe, expect, it } from "vitest";
import {
  WINDOWS_PRIVATE_SCRIPT,
  WINDOWS_PRIVATE_WORKER_SCRIPT,
} from "./windows-private.js";

// PowerShell does not run on every development machine, so these tests inspect
// the ancestor walk in the fixed scripts. Target Get-Acl, ownership, and real
// junction checks run in windows-private.native.test.ts on Windows.
function ancestorLoop(script: string): string {
  const start = script.indexOf("while ($parent)");
  const end = script.indexOf("if ($request.kind -ne 'location')", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe("the ancestor rule in the fixed ACL program", () => {
  it("rejects only link/reparse-point ancestors and never reads ancestor ACLs or owners", () => {
    for (const script of [
      WINDOWS_PRIVATE_SCRIPT,
      WINDOWS_PRIVATE_WORKER_SCRIPT,
    ]) {
      const ancestors = ancestorLoop(script);
      expect(ancestors).toContain(
        "$parent.Attributes -band [IO.FileAttributes]::ReparsePoint",
      );
      expect(ancestors).toContain("$failAncestor = $parent.FullName");
      expect(ancestors).toContain("throw 'UNSAFE_PARENT_LINK'");
      expect(ancestors).toContain("$parent = $parent.Parent");
      expect(ancestors).not.toContain("Get-Acl");
    }
  });
});
