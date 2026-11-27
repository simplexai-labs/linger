import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { partitionTestFiles, usesModuleMocks } from "../../vitest.isolation";

describe("Vitest isolation partition", () => {
  it("keeps every file that replaces modules out of the shared projects", () => {
    expect(usesModuleMocks('vi.mock("./x", () => ({}));')).toBe(true);
    expect(usesModuleMocks("vi.doMock('./x');")).toBe(true);
    expect(usesModuleMocks("vi.resetModules();")).toBe(true);
    expect(usesModuleMocks("vi.fn(); vi.spyOn(window, 'open');")).toBe(false);
  });

  it("splits the real test files without losing any", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const { isolated, shared } = partitionTestFiles(root, "src/**/*.test.tsx");
    expect(isolated).toContain("src/features/rooms/room-surface.test.tsx");
    expect(shared).toContain("src/features/rooms/room-navigation.test.tsx");
    expect(isolated.filter((file) => shared.includes(file))).toEqual([]);
    expect([...isolated, ...shared].every((file) => !file.includes("\\"))).toBe(
      true,
    );
  });
});
