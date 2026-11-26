import { expect, it } from "vitest";
import { safeAuthenticationReturnTo } from "./authentication-return-to";

const setup = "/connect-computer?code_challenge=challenge&state=state";
it("preserves a same-origin Local Computer setup path after authentication", () => {
  expect(safeAuthenticationReturnTo(setup)).toBe(setup);
});
it("preserves a same-origin Tenant Space path with query parameters", () => {
  expect(
    safeAuthenticationReturnTo("/t/tenant-northstar/dashboard?room=room-all"),
  ).toBe("/t/tenant-northstar/dashboard?room=room-all");
  expect(
    safeAuthenticationReturnTo("/t/tenant-northstar/rooms/room-all/chat"),
  ).toBe("/t/tenant-northstar/rooms/room-all/chat");
});
it.each([
  `https://evil.example${setup}`,
  `//evil.example${setup}`,
  "//evil.example/t/tenant-northstar/rooms",
  `${setup}#token`,
  "/t/tenant-northstar/rooms#fragment",
  "/connect-computer",
  "/rooms/room_private",
])("rejects unsafe or unsupported return paths: %s", (value) => {
  expect(safeAuthenticationReturnTo(value)).toBeNull();
});
