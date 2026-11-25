import { describe, expect, it } from "vitest";

import { SessionClosed } from "../session/session";
import { sendRetryingOnce } from "./upload-retry";

const lost = (error: unknown) => error instanceof SessionClosed;
const now = () => Promise.resolve();

describe("sendRetryingOnce", () => {
  it("retries on the session current at the retry, not the closed one", async () => {
    const sessions = [{ id: "relay", closed: false }];
    const used: string[] = [];
    const send = async () => {
      const session = sessions.at(-1)!;
      used.push(session.id);
      if (session.closed) throw new SessionClosed("closed");
      if (session.id === "relay") {
        // The route moves to the LAN while this upload is on the Relay.
        session.closed = true;
        sessions.push({ id: "lan", closed: false });
        throw new SessionClosed("SESSION_CLOSED");
      }
      return session.id;
    };
    await expect(sendRetryingOnce(send, lost, now)).resolves.toBe("lan");
    expect(used).toEqual(["relay", "lan"]);
  });

  it("gives up after one retry and passes other errors through", async () => {
    let calls = 0;
    const alwaysClosed = async () => {
      calls += 1;
      throw new SessionClosed("closed");
    };
    await expect(sendRetryingOnce(alwaysClosed, lost, now)).rejects.toThrow(
      SessionClosed,
    );
    expect(calls).toBe(2);
    const other = new Error("413");
    await expect(
      sendRetryingOnce(() => Promise.reject(other), lost, now),
    ).rejects.toBe(other);
  });
});
