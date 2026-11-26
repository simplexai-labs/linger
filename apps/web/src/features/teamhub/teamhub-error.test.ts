import { afterEach, describe, expect, it } from "vitest";

import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";

import { readTeamHubError, TeamHubTransportError } from "./teamhub-error";

afterEach(() => resetLanguageForTest());

function teamHubResponse(code: string, message: string, status: number) {
  return Response.json(
    { error: { code, message, request_id: "req-1" } },
    { status },
  );
}

describe("readTeamHubError", () => {
  it("keeps TeamHub's message for a code this client does not word", async () => {
    const error = await readTeamHubError(
      teamHubResponse(
        "ROOM_LEFT",
        "Rejoin this Room before sending messages.",
        403,
      ),
    );

    expect(error.code).toBe("ROOM_LEFT");
    expect(error.message).toBe("Rejoin this Room before sending messages.");
  });

  it("keeps TeamHub's message for an invalid request, which names the rule", async () => {
    await setLanguage("zh-CN");
    const error = await readTeamHubError(
      teamHubResponse("INVALID_REQUEST", "name must not be empty", 400),
    );

    expect(error.message).toBe("name must not be empty");
  });

  it("words a generic code in the interface language and keeps TeamHub's text", async () => {
    await setLanguage("zh-CN");
    const error = await readTeamHubError(
      teamHubResponse("INTERNAL_ERROR", "an unexpected error occurred", 500),
    );

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toBe(zhCN.teamHubErrors.internal);
    expect(error.serverMessage).toBe("an unexpected error occurred");
  });

  it("words a generic code in English", async () => {
    const error = await readTeamHubError(
      teamHubResponse(
        "UNAUTHENTICATED",
        "authentication is invalid or expired",
        401,
      ),
    );

    expect(error.message).toBe("Your sign-in has expired. Sign in again.");
  });

  it("words INVALID_CREDENTIALS in English and Chinese while keeping serverMessage", async () => {
    const englishError = await readTeamHubError(
      teamHubResponse(
        "INVALID_CREDENTIALS",
        "email or password is incorrect",
        401,
      ),
    );
    expect(englishError.message).toBe("Email or password is incorrect.");
    expect(englishError.serverMessage).toBe("email or password is incorrect");

    await setLanguage("zh-CN");
    const chineseError = await readTeamHubError(
      teamHubResponse(
        "INVALID_CREDENTIALS",
        "email or password is incorrect",
        401,
      ),
    );
    expect(chineseError.message).toBe(zhCN.teamHubErrors.invalidCredentials);
    expect(chineseError.serverMessage).toBe("email or password is incorrect");
  });

  it.each([
    ["CONFLICT", "This email was already sent.", 409],
    ["FORBIDDEN", "Only the decision owner can decide this request.", 403],
    ["NOT_FOUND", "Shared with me is unavailable.", 404],
    ["PAYLOAD_TOO_LARGE", "Document content exceeds 10 MiB.", 413],
    ["SERVICE_UNAVAILABLE", "Comment service unavailable", 503],
  ])(
    "keeps TeamHub's message for %s, which says what to do",
    async (code, message, status) => {
      await setLanguage("zh-CN");
      const error = await readTeamHubError(
        teamHubResponse(code, message, status),
      );

      expect(error.message).toBe(message);
    },
  );

  it("explains a refusal from a layer in front of TeamHub without the raw status", async () => {
    const error = await readTeamHubError(
      new Response("<html>Forbidden</html>", { status: 403 }),
    );

    expect(error.code).toBe("HTTP_403");
    expect(error.status).toBe(403);
    expect(error.serverMessage).toBeUndefined();
    expect(error.message).toBe(
      "The server refused this request. Reload the page and try again.",
    );
  });

  it("words a response without a TeamHub body in the interface language", async () => {
    await setLanguage("zh-CN");
    const error = await readTeamHubError(
      new Response("Bad gateway", { status: 418 }),
    );

    expect(error.message).toBe(
      zhCN.teamHubErrors.notCompleted.replace("{status}", "418"),
    );
  });
});

describe("TeamHubTransportError", () => {
  it("reads as a connection problem in the interface language", async () => {
    await setLanguage("zh-CN");
    expect(new TeamHubTransportError().message).toBe(
      zhCN.teamHubErrors.unreachable,
    );
  });
});
