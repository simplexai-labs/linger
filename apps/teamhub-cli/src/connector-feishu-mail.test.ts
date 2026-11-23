import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import { connectorVersions, type Json } from "./connector-runtime.js";
import { requestBodyText, requestUrlText } from "./test-support/fetch-text.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// TeamHub serves the Feishu Mail tools itself, so the fixture answers their
// calls in the CLI's mail shape, as TeamHub's tool provider does.
async function fixture(handler: (slug: string, args: Json) => unknown) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "feishu-mail-"));
  roots.push(cwd);
  const calls: { slug: string; args: Json }[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = requestUrlText(url);
    const body: Json = init?.body ? JSON.parse(requestBodyText(init.body)) : {};
    if (endpoint.endsWith("/apps/account"))
      return Response.json({
        status: "ready",
        account: {
          connection_id: "connection_feishu",
          app_key: "feishu_mail",
          display_name: "Feishu Mail",
          identity_label: "owner@example.test",
        },
      });
    if (endpoint.endsWith("/apps/tools/bind")) {
      expect(body.tool_version).toBe(connectorVersions["feishu-mail"]);
      return Response.json({
        tools: (body.tool_slugs as string[]).map((slug) => ({
          tool_slug: slug,
          tool_version: body.tool_version,
          app_key: "feishu_mail",
          input_schema: { type: "object" },
        })),
      });
    }
    if (endpoint.endsWith("/apps/gmail/canvas-draft")) {
      calls.push({ slug: "canvas-draft", args: body });
      return Response.json({
        draft_id: "draft_canvas",
        inline_images: 1,
        attachments: ["plan.pdf"],
      });
    }
    if (endpoint.endsWith("/apps/mail-body"))
      return Response.json({ html: "<h1>Converted</h1>\n" });
    if (endpoint.endsWith("/apps/tools/execute")) {
      const slug = String(body.tool_slug);
      calls.push({ slug, args: body.arguments as Json });
      return Response.json({
        data: await handler(slug, body.arguments as Json),
      });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  const run = async (args: string[]) => {
    output.length = 0;
    errors.length = 0;
    const code = await runCli(["feishu-mail", ...args, "--json"], {
      cwd,
      env: {
        TEAMHUB_URL: "https://teamhub.example",
        TEAMHUB_TOKEN: "th_agent_fixture",
        TEAMHUB_STATE_ROOT: cwd,
      },
      fetch: fetcher,
      stdout: (s: string) => {
        output.push(s);
      },
      stderr: (s: string) => {
        errors.push(s);
      },
    });
    return {
      code,
      result: output.length ? JSON.parse(output.join("")) : undefined,
      error: errors.length ? JSON.parse(errors.join("")) : undefined,
    };
  };
  return { cwd, calls, run };
}

const summary = {
  messageId: "m1",
  threadId: "t1",
  subject: "Plan",
  from: { email: "alice@example.test" },
  unread: true,
};

describe("teamhub feishu-mail", () => {
  it("lists the inbox and pages with a cursor", async () => {
    const f = await fixture(() => ({
      messages: [summary],
      next_page_token: "page-2",
    }));

    const listed = await f.run(["list", "--unread"]);

    expect(listed.code).toBe(0);
    expect(f.calls).toEqual([
      {
        slug: "FEISHU_MAIL_LIST_MESSAGES",
        args: { folder: "inbox", unread_only: true, page_size: 20 },
      },
    ]);
    expect(listed.result.messages).toEqual([summary]);
    expect(listed.result.hasMore).toBe(true);

    const next = await f.run([
      "list",
      "--unread",
      "--cursor",
      listed.result.nextCursor,
    ]);
    expect(next.code).toBe(0);
    expect(f.calls[1]!.args.page_token).toBe("page-2");
  });

  it("sends a new message through a draft with its attachment", async () => {
    const f = await fixture((slug) =>
      slug === "FEISHU_MAIL_CREATE_DRAFT"
        ? { draft_id: "d1" }
        : { draft_id: "d1", message_id: "m9", thread_id: "t9" },
    );
    await writeFile(path.join(f.cwd, "notes.txt"), "attached");

    const sent = await f.run([
      "send",
      "--to",
      "bob@example.test",
      "--subject",
      "Update",
      "--markdown",
      "--content",
      "# Hello",
      "--attach",
      "notes.txt",
    ]);

    expect(sent.code).toBe(0);
    expect(f.calls.map((call) => call.slug)).toEqual([
      "FEISHU_MAIL_CREATE_DRAFT",
      "FEISHU_MAIL_SEND_DRAFT",
    ]);
    expect(f.calls[0]!.args).toEqual({
      to: ["bob@example.test"],
      subject: "Update",
      body: "<h1>Converted</h1>\n",
      body_format: "html",
      attachments: [
        {
          name: "notes.txt",
          content_type: "text/plain",
          content_base64: Buffer.from("attached").toString("base64"),
        },
      ],
    });
    expect(f.calls[1]!.args).toEqual({ draft_id: "d1" });
    expect(sent.result.result).toMatchObject({
      action: "sent",
      draftId: "d1",
      messageId: "m9",
      threadId: "t9",
    });
  });

  it("replies to everyone through a reply draft", async () => {
    const f = await fixture((slug) =>
      slug === "FEISHU_MAIL_CREATE_DRAFT"
        ? { draft_id: "d2" }
        : { draft_id: "d2", message_id: "m3" },
    );

    const replied = await f.run([
      "reply",
      "m1",
      "--all",
      "--content",
      "Thanks",
    ]);

    expect(replied.code).toBe(0);
    expect(f.calls[0]).toEqual({
      slug: "FEISHU_MAIL_CREATE_DRAFT",
      args: {
        body: "Thanks",
        body_format: "text",
        reply_to_message_id: "m1",
        reply_all: true,
      },
    });
    expect(f.calls[1]!.slug).toBe("FEISHU_MAIL_SEND_DRAFT");
  });

  it("reports the draft when the send after it fails", async () => {
    const f = await fixture((slug) => {
      if (slug === "FEISHU_MAIL_SEND_DRAFT")
        return { successful: false, error: "blocked" };
      return { draft_id: "d3" };
    });

    const failed = await f.run([
      "send",
      "--to",
      "bob@example.test",
      "--subject",
      "Update",
      "--content",
      "Body",
    ]);

    expect(failed.code).not.toBe(0);
    expect(JSON.stringify(failed.error)).toContain("d3");
  });

  it("downloads an attachment TeamHub fetched from Feishu", async () => {
    const f = await fixture((slug) =>
      slug === "FEISHU_MAIL_GET_MESSAGE"
        ? {
            message: {
              ...summary,
              bodyText: "Body",
              attachments: [
                { attachmentId: "a1", name: "report.pdf", isInline: false },
              ],
            },
          }
        : {
            attachment_id: "a1",
            content_base64: Buffer.from("pdf-bytes").toString("base64"),
          },
    );

    const downloaded = await f.run([
      "download",
      "m1",
      "--attachment",
      "report.pdf",
      "--output",
      "report.pdf",
    ]);

    expect(downloaded.code).toBe(0);
    expect(await readFile(path.join(f.cwd, "report.pdf"), "utf8")).toBe(
      "pdf-bytes",
    );
    expect(f.calls[1]).toEqual({
      slug: "FEISHU_MAIL_GET_ATTACHMENT",
      args: { message_id: "m1", attachment_id: "a1" },
    });
  });

  it("saves a canvas as a Feishu Mail draft on the Feishu connection", async () => {
    const f = await fixture(() => {
      throw new Error("canvas drafts use their own endpoint");
    });

    const drafted = await f.run(["canvas-draft", "document_plan"]);

    expect(drafted.code).toBe(0);
    expect(f.calls).toEqual([
      {
        slug: "canvas-draft",
        args: {
          connection_id: "connection_feishu",
          document_id: "document_plan",
        },
      },
    ]);
    expect(drafted.result.result).toMatchObject({
      action: "drafted",
      draftId: "draft_canvas",
      inlineImages: 1,
      attachments: ["plan.pdf"],
    });
  });

  it("refuses a folder-wide list without search text before calling TeamHub", async () => {
    const f = await fixture(() => {
      throw new Error("must not call TeamHub");
    });

    const listed = await f.run(["list", "--folder", "all"]);

    expect(listed.code).not.toBe(0);
    expect(listed.error.error.code).toBe("unsupported_combination");
    expect(f.calls).toEqual([]);
  });
});
