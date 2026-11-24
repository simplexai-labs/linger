import { describe, expect, it } from "vitest";
import { WINDOWS_PRIVATE_SCRIPT } from "./windows-private.js";

// PowerShell does not run on every development machine, so these tests read
// the rights and trusted-principal hooks out of the fixed script. Get-Acl, the
// owner check and the walk itself run in windows-private.native.test.ts on
// Windows.
const ANCESTORS = WINDOWS_PRIVATE_SCRIPT.slice(
  WINDOWS_PRIVATE_SCRIPT.indexOf("while ($parent)"),
  WINDOWS_PRIVATE_SCRIPT.indexOf("if ($request.kind -ne 'location')"),
);
const names = (pattern: RegExp) =>
  (pattern.exec(ANCESTORS)?.[1] ?? "").split(",").filter(Boolean);
const EVERYWHERE = names(/\$replace = '([A-Za-z,]+)'/);
const BELOW_ROOT = names(
  /if \(\$parent\.Parent\) \{ \$replace = "([A-Za-z,]+),\$replace" \}/,
);
const TRUSTED_INSTALLER =
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

// System.Security.AccessControl.FileSystemRights values the script names.
const RIGHTS: Record<string, number> = {
  DeleteSubdirectoriesAndFiles: 0x40,
  Delete: 0x10000,
  ChangePermissions: 0x40000,
  TakeOwnership: 0x80000,
};
const mask = (rights: string[]) =>
  rights.reduce((bits, right) => {
    const value = RIGHTS[right];
    if (value === undefined) throw new Error(`Unknown right ${right}`);
    return bits | value;
  }, 0);
// Modify, the right Windows gives Authenticated Users on every data drive it
// formats, and which folders made on that drive inherit.
const MODIFY = 0x1301bf;
// FullControl, the right stock secondary NTFS drives grant Everyone:(OI)(CI)(F).
const FULL_CONTROL = 0x1f01ff;

describe("the ancestor rule in the fixed ACL program", () => {
  it("counts Delete only on a folder that has a parent and aligns trusted ancestor SIDs with privatefs", () => {
    expect(EVERYWHERE).toEqual([
      "DeleteSubdirectoriesAndFiles",
      "ChangePermissions",
      "TakeOwnership",
    ]);
    expect(BELOW_ROOT).toEqual(["Delete"]);
    expect(ANCESTORS).toContain(
      "[Security.AccessControl.FileSystemRights]$replace",
    );
    expect(WINDOWS_PRIVATE_SCRIPT).toContain(TRUSTED_INSTALLER);
    expect(ANCESTORS).toContain(
      "$ruleSid -in @($sid.Value, $system, $admins, 'S-1-3-0', 'S-1-3-4', $trustedInstaller)",
    );
    expect(ANCESTORS).toContain("Test-BuiltinAdminSid");
    expect(ANCESTORS).toContain("Get-LocalAdminMemberSids");
    expect(ANCESTORS).toContain("Get-CodexSandboxSids");
    expect(ANCESTORS).toContain("$failAncestor = $parent.FullName");
    expect(ANCESTORS).toContain("$failSid = $ruleSid");
  });

  it("lets others hold Modify on a data drive's root but rejects Modify below it and FullControl everywhere", () => {
    expect(MODIFY & mask(EVERYWHERE)).toBe(0);
    expect(MODIFY & mask([...BELOW_ROOT, ...EVERYWHERE])).toBe(RIGHTS.Delete);
    expect(FULL_CONTROL & mask(EVERYWHERE)).toBe(mask(EVERYWHERE));
  });
});
