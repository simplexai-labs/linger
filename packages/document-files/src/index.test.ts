import { expect, it } from "vitest";
import {
  extractDocumentImages,
  bundleDocumentImages,
  prepareDocumentSource,
} from "./index.js";

it.each([
  [
    "root definitions",
    "[chart]: data:image/gif;base64,R0lGODlh\n\n[CHART]: data:image/gif;base64,R0lGODdh",
  ],
  [
    "a definition in a quote",
    "> [chart]: data:image/gif;base64,R0lGODlh\n\n[chart]: data:image/gif;base64,R0lGODdh",
  ],
  [
    "a definition in a list",
    "- Notes\n\n  [chart]: data:image/gif;base64,R0lGODlh",
  ],
])(
  "resolves the first document-wide image definition with %s",
  (_name, definitions) => {
    const content = Buffer.from(`![chart][ChArT]\n\n${definitions}\n`);
    const snapshot = {
      filePath: "report.md",
      content,
      sizeBytes: content.length,
      sha256: "",
    };
    const extracted = extractDocumentImages(snapshot);
    expect([...extracted.files.values()]).toEqual([Buffer.from("GIF89a")]);
    expect(Buffer.from(extracted.content).toString()).not.toContain(
      "data:image",
    );
    const prepared = prepareDocumentSource(snapshot);
    expect(prepared.image_count).toBe(1);
    expect(prepared.markdown).toContain("document-image:");
    expect(prepared.markdown).not.toContain("data:image");
  },
);

it("keeps definitions that ordinary links still use after extracting images", () => {
  const content = Buffer.from(
    "![chart][asset]\n\n[Download][asset]\n\n> [asset]: data:image/gif;base64,R0lGODlh\n\n[Website][site]\n\n[site]: https://example.test/\n\n`![not an image][asset]`\n",
  );
  const snapshot = {
    filePath: "report.md",
    content,
    sizeBytes: content.length,
    sha256: "",
  };
  const extracted = extractDocumentImages(snapshot);
  expect([...extracted.files.values()]).toEqual([Buffer.from("GIF89a")]);
  for (const markdown of [
    Buffer.from(extracted.content).toString(),
    prepareDocumentSource(snapshot).markdown,
  ]) {
    expect(markdown).toContain("[Download][asset]");
    expect(markdown).toContain("[asset]: data:image/gif;base64,R0lGODlh");
    expect(markdown).toContain("[Website][site]");
    expect(markdown).toContain("[site]: https://example.test/");
    expect(markdown).toContain("`![not an image][asset]`");
  }
});

it("bundles the first nested local definition without reading a later duplicate", async () => {
  const content = Buffer.from(
    "![chart][chart]\n\n> [chart]: first.gif\n\n[chart]: second.gif\n",
  );
  const reads: string[] = [];
  const bundled = await bundleDocumentImages(
    { filePath: "report.md", content, sizeBytes: content.length, sha256: "" },
    async (filePath) => {
      reads.push(filePath);
      const bytes = Buffer.from(
        filePath.endsWith("first.gif") ? "GIF89a" : "GIF87a",
      );
      return { filePath, content: bytes, sizeBytes: bytes.length, sha256: "" };
    },
    new AbortController().signal,
  );
  expect(reads).toEqual(["./playground/first.gif"]);
  expect(Buffer.from(bundled.content).toString()).toContain(
    "![chart](data:image/gif;base64,R0lGODlh)",
  );
});

it("extracts duplicate reference-style images once, preserves code, and restores image bytes", async () => {
  const encoded = "R0lGODlh";
  const snapshot = {
    filePath: "report.md",
    content: Buffer.from(
      `![a][image]\n\n![b][image]\n\n[image]: data:image/gif;base64,${encoded}\n\n\`data:image/gif;base64,${encoded}\`\n`,
    ),
    sizeBytes: 0,
    sha256: "",
  };
  const result = extractDocumentImages(snapshot);
  expect(result.files.size).toBe(1);
  const markdown = Buffer.from(result.content).toString();
  expect(markdown).toContain("`data:image/gif;base64,R0lGODlh`");
  expect(markdown.match(/report.md.image-/gu)).toHaveLength(2);
  const bundled = await bundleDocumentImages(
    { ...snapshot, content: result.content },
    async (filePath) => {
      const content = result.files.get(filePath.slice(13))!;
      return { filePath, content, sizeBytes: content.length, sha256: "" };
    },
    new AbortController().signal,
  );
  expect(
    Buffer.from(bundled.content)
      .toString()
      .match(/data:image\/gif;base64,R0lGODlh/gu),
  ).toHaveLength(3);
});

it("bounds parallel image reads, deduplicates sources, and waits for in-flight reads on failure", async () => {
  const content = Buffer.from(
    Array.from({ length: 12 }, (_, i) => `![${i}](image-${i % 6}.gif)`).join(
      "\n",
    ),
  );
  let active = 0,
    maximum = 0,
    calls = 0;
  const snapshot = {
    filePath: "report.md",
    content,
    sizeBytes: content.length,
    sha256: "",
  };
  const read = async (filePath: string) => {
    active++;
    calls++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return {
      filePath,
      content: Buffer.from("GIF89a"),
      sizeBytes: 6,
      sha256: "",
    };
  };
  const result = await bundleDocumentImages(
    snapshot,
    read,
    new AbortController().signal,
  );
  expect(calls).toBe(6);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(
    Buffer.from(result.content)
      .toString()
      .match(/data:image/g),
  ).toHaveLength(12);
  let started = 0;
  await expect(
    bundleDocumentImages(
      snapshot,
      async (p) => {
        if (++started === 2) throw new Error("read failed");
        return read(p);
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("read failed");
  expect(active).toBe(0);
});

it.each(["local image", "document source"])(
  "rejects cancellation during the final %s read",
  async (kind) => {
    const sourceContent = Buffer.from(
      "![chart](data:image/gif;base64,R0lGODlh)\n",
    );
    const source = {
      filePath: "source.md",
      content: sourceContent,
      sizeBytes: sourceContent.length,
      sha256: "",
    };
    const content = Buffer.from(
      kind === "local image"
        ? "![chart](chart.gif)\n"
        : prepareDocumentSource(source).markdown,
    );
    const snapshot = {
      filePath: "report.md",
      content,
      sizeBytes: content.length,
      sha256: "",
    };
    const controller = new AbortController();
    const reason = new Error("send cancelled");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bundled = bundleDocumentImages(
      snapshot,
      async (filePath) => {
        entered();
        await pending;
        const bytes =
          kind === "local image" ? Buffer.from("GIF89a") : sourceContent;
        return {
          filePath,
          content: bytes,
          sizeBytes: bytes.length,
          sha256: "",
        };
      },
      controller.signal,
    );
    await started;
    controller.abort(reason);
    release();
    await expect(bundled).rejects.toBe(reason);
  },
);

it("honors an already cancelled Markdown bundle without images", async () => {
  const content = Buffer.from("# Notes\n");
  const snapshot = {
    filePath: "report.md",
    content,
    sizeBytes: content.length,
    sha256: "",
  };
  const reason = new Error("send cancelled");
  await expect(
    bundleDocumentImages(
      snapshot,
      async () => {
        throw new Error("unexpected read");
      },
      AbortSignal.abort(reason),
    ),
  ).rejects.toBe(reason);
});
