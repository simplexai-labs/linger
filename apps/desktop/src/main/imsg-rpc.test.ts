import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { IMsgRpc, type IMsgChild, type IMsgMessage } from "./imsg-rpc.js";
import { silentLog } from "./test-support.js";

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeChild extends EventEmitter implements IMsgChild {
  readonly requests: Request[] = [];
  readonly stdout = new PassThrough();
  ended = false;
  exited = false;
  onRequest: (request: Request) => void = () => {};
  readonly stdin = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string): boolean => {
      if (this.stdin.writableEnded) {
        // A real stream reports a write after end as an error event.
        this.stdin.emit("error", new Error("write after end"));
        return false;
      }
      const request = JSON.parse(chunk) as Request;
      this.requests.push(request);
      this.onRequest(request);
      return true;
    },
    end: (): void => {
      this.stdin.writableEnded = true;
      this.ended = true;
      setImmediate(() => this.exit(0));
    },
  });
  readonly kill = vi.fn(() => {
    this.exit(null);
    return true;
  });

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }

  line(record: unknown): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  reply(id: number, result: unknown): void {
    this.line({ jsonrpc: "2.0", id, result });
  }

  fail(id: number, code: number, data?: unknown): void {
    this.line({ jsonrpc: "2.0", id, error: { code, message: "no", data } });
  }

  notify(method: string, params: unknown): void {
    this.line({ jsonrpc: "2.0", method, params });
  }
}

const setup = (cursor?: number) => {
  const children: FakeChild[] = [];
  const waits: number[] = [];
  const messages: IMsgMessage[] = [];
  let nextSubscription = 1;
  const rpc = new IMsgRpc({
    executable: "/imsg",
    log: silentLog,
    spawn: (executable, args) => {
      expect([executable, ...args]).toEqual(["/imsg", "rpc"]);
      const child = new FakeChild();
      child.onRequest = (request) => {
        if (request.method === "watch.subscribe")
          setImmediate(() =>
            child.reply(request.id, { subscription: nextSubscription++ }),
          );
      };
      children.push(child);
      return child;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    stopTimeoutMs: 50,
  });
  rpc.start({ cursor: () => cursor, message: (m) => messages.push(m) });
  return { rpc, children, waits, messages };
};

const subscribed = async (child: FakeChild, count = 1) =>
  vi.waitFor(() =>
    expect(
      child.requests.filter((r) => r.method === "watch.subscribe"),
    ).toHaveLength(count),
  );

describe("IMsgRpc", () => {
  it("subscribes from the tail on the first start", async () => {
    const f = setup();
    await subscribed(f.children[0]!);
    expect(f.children[0]!.requests[0]!.params).toEqual({});
    await f.rpc.stop();
    expect(f.children[0]!.ended).toBe(true);
  });

  it("resumes after the stored row and delivers messages", async () => {
    const f = setup(42);
    const child = f.children[0]!;
    await subscribed(child);
    expect(child.requests[0]!.params).toEqual({ since_rowid: 42 });
    // Wait for the subscription id to land.
    await new Promise((resolve) => setImmediate(resolve));
    child.notify("message", {
      subscription: 1,
      message: { id: 43, text: "x" },
    });
    child.notify("message", { subscription: 99, message: { id: 44 } });
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    expect(f.messages[0]!.id).toBe(43);
    await f.rpc.stop();
  });

  it("subscribes again after an overflow", async () => {
    const f = setup(5);
    const child = f.children[0]!;
    await subscribed(child);
    await new Promise((resolve) => setImmediate(resolve));
    child.notify("watch.overflow", {
      subscription: 1,
      resume_after_rowid: 900,
      terminal: true,
    });
    await subscribed(child, 2);
    expect(child.requests[1]!.params).toEqual({ since_rowid: 900 });
    await f.rpc.stop();
  });

  it("restarts a crashed child with growing backoff", async () => {
    const f = setup();
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(f.children).toHaveLength(i + 1));
      f.children[i]!.exit(1);
    }
    await vi.waitFor(() => expect(f.children).toHaveLength(4));
    expect(f.waits).toEqual([1_000, 2_000, 4_000]);
    await f.rpc.stop();
  });

  it("sends to a chat or a handle", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    child.onRequest = (r) =>
      r.method === "send" && child.reply(r.id, { ok: true, guid: "G1" });
    expect(await f.rpc.send({ chatId: 7 }, "hi")).toEqual({ ok: true });
    await f.rpc.send({ to: "a@b.co" }, "yo");
    const sends = child.requests.filter((r) => r.method === "send");
    expect(sends.map((r) => r.params)).toEqual([
      { chat_id: 7, text: "hi" },
      { to: "a@b.co", text: "yo", service: "imessage" },
    ]);
    await f.rpc.stop();
  });

  it("reports whether a failed send may be retried", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    const answers = [
      { code: -32603, data: { retry_safe: true, disposition: "not_started" } },
      {
        code: -32001,
        data: { retry_safe: false, disposition: "may_have_completed" },
      },
    ];
    child.onRequest = (r) => {
      if (r.method !== "send") return;
      const answer = answers.shift()!;
      child.fail(r.id, answer.code, answer.data);
    };
    expect(await f.rpc.send({ chatId: 1 }, "a")).toEqual({
      ok: false,
      retrySafe: true,
    });
    expect(await f.rpc.send({ chatId: 1 }, "b")).toEqual({
      ok: false,
      retrySafe: false,
    });
    await f.rpc.stop();
  });

  it("restarts the child when the send lane is poisoned", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    child.onRequest = (r) =>
      r.method === "send" &&
      child.fail(r.id, -32004, {
        retry_safe: true,
        disposition: "not_started",
      });
    expect(await f.rpc.send({ chatId: 1 }, "a")).toEqual({
      ok: false,
      retrySafe: true,
    });
    expect(child.ended).toBe(true);
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    await f.rpc.stop();
  });

  it("reads a chat's service", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    child.onRequest = (r) => {
      if (r.method !== "chats.get") return;
      if (r.params.chat_id === 1) child.reply(r.id, { id: 1, service: "SMS" });
      else if (r.params.chat_id === 2) child.fail(r.id, -32602);
      else child.fail(r.id, -32002);
    };
    expect(await f.rpc.chatService(1)).toBe("SMS");
    expect(await f.rpc.chatService(2)).toBeUndefined();
    await expect(f.rpc.chatService(3)).rejects.toThrow();
    expect(
      child.requests.filter((r) => r.method === "chats.get")[0]!.params,
    ).toEqual({ chat_id: 1 });
    await f.rpc.stop();
  });

  it("refuses requests while the child restarts without writing", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    // Poisoned: the child's stdin closes for the restart.
    child.onRequest = (r) =>
      r.method === "send" && child.fail(r.id, -32004, { retry_safe: true });
    await f.rpc.send({ chatId: 1 }, "a");
    expect(child.ended).toBe(true);
    const sends = child.requests.length;
    expect(await f.rpc.send({ chatId: 1 }, "b")).toEqual({
      ok: false,
      retrySafe: true,
      notRunning: true,
    });
    await expect(f.rpc.chatService(1)).rejects.toThrow("not running");
    expect(child.requests).toHaveLength(sends);
    await f.rpc.stop();
  });

  it("survives a stdin error such as EPIPE", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    expect(() =>
      child.stdin.emit(
        "error",
        Object.assign(new Error("EPIPE"), { code: "EPIPE" }),
      ),
    ).not.toThrow();
    await f.rpc.stop();
  });

  it("treats a child that exits mid-send as uncertain", async () => {
    const f = setup();
    const child = f.children[0]!;
    await subscribed(child);
    child.onRequest = (r) => r.method === "send" && child.exit(1);
    expect(await f.rpc.send({ chatId: 1 }, "a")).toMatchObject({
      ok: false,
      retrySafe: false,
    });
    await f.rpc.stop();
  });
});
