import { expect, it } from "vitest";
import {
  DocumentImageError,
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

const gifDataUri =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

it.each([
  "Sprint 12.md",
  "Sprint #12.md",
  "Progress 50%.md",
  "#12.md",
  "What?.md",
  "Rate 5%2B.md",
  "Q1:Summary.md",
  "file:notes.md",
  "data:report.md",
  "document-image:draft.md",
  "a(b.md",
  "a)b.md",
  "Report (Final).md",
  "café #1 50%.md",
])(
  "extracts and re-bundles images when the document filename is %s",
  async (filePath) => {
    const content = Buffer.from(`![chart](${gifDataUri})\n`);
    const snapshot = {
      filePath,
      content,
      sizeBytes: content.length,
      sha256: "",
    };
    const extracted = extractDocumentImages(snapshot);
    expect(extracted.files.size).toBe(1);
    const [literalFilename] = [...extracted.files.keys()];
    const expectedPrefix = `${Array.from(filePath).slice(0, 20).join("")}.image-`;
    expect(literalFilename).toBeDefined();
    expect(literalFilename!.startsWith(expectedPrefix)).toBe(true);
    expect(literalFilename!.endsWith(".gif")).toBe(true);
    expect(extracted.files.has(literalFilename!)).toBe(true);

    const expectedEncoded = encodeURIComponent(literalFilename!).replace(
      /[()]/gu,
      (character) => (character === "(" ? "%28" : "%29"),
    );
    const markdown = Buffer.from(extracted.content).toString();
    expect(markdown).toBe(`![chart](${expectedEncoded})\n`);
    expect(markdown).not.toContain("\\");
    expect(markdown).not.toContain("#");
    expect(markdown).not.toContain("?");

    const reads: string[] = [];
    const bundled = await bundleDocumentImages(
      {
        filePath,
        content: extracted.content,
        sizeBytes: extracted.content.length,
        sha256: "",
      },
      async (readPath) => {
        reads.push(readPath);
        const bytes = extracted.files.get(
          readPath.slice("./playground/".length),
        );
        if (!bytes) throw new Error(`missing image: ${readPath}`);
        return {
          filePath: readPath,
          content: bytes,
          sizeBytes: bytes.length,
          sha256: "",
        };
      },
      new AbortController().signal,
    );
    expect(reads).toEqual([`./playground/${literalFilename!}`]);
    expect(Buffer.from(bundled.content).toString()).toContain(
      `![chart](${gifDataUri})`,
    );
  },
);

it("extracts and re-bundles subdirectory documents and parent-relative shared images", async () => {
  const filePath = "sub #1/Sprint #12.md";
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const content = Buffer.from(
    `![chart](${gifDataUri})\n\n![shared](../shared/my%20photo.png)\n`,
  );
  const extracted = extractDocumentImages({
    filePath,
    content,
    sizeBytes: content.length,
    sha256: "",
  });
  expect(extracted.files.size).toBe(1);
  const [literalFilename] = [...extracted.files.keys()];
  const sidecarPath = `./playground/sub #1/${literalFilename!}`;
  const sharedPath = "./playground/shared/my photo.png";

  const reads: string[] = [];
  const bundled = await bundleDocumentImages(
    {
      filePath,
      content: extracted.content,
      sizeBytes: extracted.content.length,
      sha256: "",
    },
    async (readPath) => {
      reads.push(readPath);
      if (readPath === sidecarPath) {
        const bytes = extracted.files.get(literalFilename!)!;
        return {
          filePath: readPath,
          content: bytes,
          sizeBytes: bytes.length,
          sha256: "",
        };
      }
      if (readPath === sharedPath) {
        return {
          filePath: readPath,
          content: pngBytes,
          sizeBytes: pngBytes.length,
          sha256: "",
        };
      }
      throw new Error(`unexpected read: ${readPath}`);
    },
    new AbortController().signal,
  );
  expect(reads).toEqual([sidecarPath, sharedPath]);
  const output = Buffer.from(bundled.content).toString();
  expect(output).toContain(`![chart](${gifDataUri})`);
  expect(output).toContain(
    `![shared](data:image/png;base64,${pngBytes.toString("base64")})`,
  );
});

it.each([
  ["![a](my%20photo.png)", "./playground/my photo.png"],
  ["![a](%2312.png)", "./playground/#12.png"],
  ["![a](50%25.png)", "./playground/50%.png"],
  ["![a](<my photo.png>)", "./playground/my photo.png"],
  [
    "![a](<Sprint 12.md.image-abc.gif>)",
    "./playground/Sprint 12.md.image-abc.gif",
  ],
  ["![a](sub%20dir/my%20photo.png)", "./playground/sub dir/my photo.png"],
  ["![a](./my%20photo.png)", "./playground/my photo.png"],
  ["![a](what%3F.png)", "./playground/what?.png"],
  ["![a](Q1%3ASummary.png)", "./playground/Q1:Summary.png"],
])(
  "decodes percent-encoded local image reference %s to literal path %s",
  async (markdown, expectedPath) => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const content = Buffer.from(`${markdown}\n`);
    const reads: string[] = [];
    const bundled = await bundleDocumentImages(
      {
        filePath: "report.md",
        content,
        sizeBytes: content.length,
        sha256: "",
      },
      async (filePath) => {
        reads.push(filePath);
        return {
          filePath,
          content: pngBytes,
          sizeBytes: pngBytes.length,
          sha256: "",
        };
      },
      new AbortController().signal,
    );
    expect(reads).toEqual([expectedPath]);
    expect(Buffer.from(bundled.content).toString()).toContain(
      `![a](data:image/png;base64,${pngBytes.toString("base64")})`,
    );
  },
);

it("leaves page fragments and external image URLs untouched without reading files", async () => {
  const content = Buffer.from(
    "![Chart](#section)\n\n![Chart](#foo/..)\n\n![Chart](#a\\b)\n\n![b](https://example.test/a.png)\n",
  );
  const snapshot = {
    filePath: "report.md",
    content,
    sizeBytes: content.length,
    sha256: "",
  };
  const reads: string[] = [];
  const bundled = await bundleDocumentImages(
    snapshot,
    async (filePath) => {
      reads.push(filePath);
      throw new Error(`unexpected read: ${filePath}`);
    },
    new AbortController().signal,
  );
  expect(reads).toEqual([]);
  expect(bundled).toBe(snapshot);
});

it("propagates readFile errors for missing explicitly-encoded hash filenames", async () => {
  const content = Buffer.from("![a](%23missing.png)\n");
  const reads: string[] = [];
  const missingError = Object.assign(new Error("ENOENT: missing"), {
    code: "ENOENT",
  });
  await expect(
    bundleDocumentImages(
      {
        filePath: "report.md",
        content,
        sizeBytes: content.length,
        sha256: "",
      },
      async (filePath) => {
        reads.push(filePath);
        throw missingError;
      },
      new AbortController().signal,
    ),
  ).rejects.toBe(missingError);
  expect(reads).toEqual(["./playground/#missing.png"]);
});

it.each([
  "![a](photo.png?v=1)",
  "![a](photo.png#fig1)",
  "![a](?v=1)",
  "![a](50%.png)",
  "![a](bad%ZZ.png)",
  "![a](%C0%AFsecret.png)",
  "![a](a%0Ab.png)",
  `![a](document-image:${"a".repeat(64)}?source=%ZZ&sha256=${"b".repeat(64)})`,
  `![a](document-image:${"a".repeat(64)}?source=.%2Fplayground%2FC%3A%2Fsecret.md&sha256=${"b".repeat(64)})`,
  "![a](/secret.png)",
  "![a](%2Fsecret.png)",
  "![a](../../secret.png)",
  "![a](..%2F..%2Fsecret.png)",
  "![a](a%5Cb.png)",
  "![a](a%00b.png)",
  "![a](file:secret.png)",
  "![a](C%3A/secret.png)",
  "![a](D%3Asecret.png)",
  "![a](./C%3A/secret.png)",
  "![a](sub/../C%3A/secret.png)",
])(
  "rejects invalid image reference %s without calling readFile",
  async (markdown) => {
    const content = Buffer.from(`${markdown}\n`);
    const reads: string[] = [];
    const error = await bundleDocumentImages(
      {
        filePath: "report.md",
        content,
        sizeBytes: content.length,
        sha256: "",
      },
      async (filePath) => {
        reads.push(filePath);
        throw new Error(`unexpected read: ${filePath}`);
      },
      new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentImageError);
    expect(error).toMatchObject({
      name: "DocumentImageError",
      code: "invalid_document_images",
    });
    expect(reads).toEqual([]);
  },
);
