import { describe, expect, it } from "vitest";

import { buildMultipart } from "./multipart";

describe("buildMultipart", () => {
  it("writes text fields and a binary file part byte for byte", () => {
    const file = Uint8Array.from([0, 255, 13, 10, 45, 45]);
    const { contentType, body } = buildMultipart(
      [
        { name: "filename", value: 'résumé "v2".pdf' },
        {
          name: "content",
          value: file,
          filename: 'résumé "v2".pdf',
          contentType: "application/pdf",
        },
      ],
      "BOUNDARY",
    );
    expect(contentType).toBe("multipart/form-data; boundary=BOUNDARY");
    const head = new TextEncoder().encode(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="filename"\r\n\r\n' +
        'résumé "v2".pdf\r\n' +
        '--BOUNDARY\r\nContent-Disposition: form-data; name="content"; filename="résumé %22v2%22.pdf"\r\n' +
        "Content-Type: application/pdf\r\n\r\n",
    );
    const tail = new TextEncoder().encode("\r\n--BOUNDARY--\r\n");
    expect(body.length).toBe(head.length + file.length + tail.length);
    expect(body.subarray(0, head.length)).toEqual(head);
    expect(body.subarray(head.length, head.length + file.length)).toEqual(file);
    expect(body.subarray(head.length + file.length)).toEqual(tail);
  });

  it("uses a fresh random boundary by default", () => {
    const first = buildMultipart([{ name: "a", value: "1" }]).contentType;
    const second = buildMultipart([{ name: "a", value: "1" }]).contentType;
    expect(first).not.toBe(second);
  });
});
