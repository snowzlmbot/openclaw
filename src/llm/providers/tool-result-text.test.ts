import { describe, expect, it } from "vitest";
import { truncateStructuredToolResultText } from "../../logging/tool-result-serialization.js";
import { extractToolResultText } from "./tool-result-text.js";

const TRUNCATION_MARKER = "…(truncated)…";

describe("extractToolResultText", () => {
  it("keeps text blocks and serializes structured non-image blocks", () => {
    expect(
      extractToolResultText([
        { type: "text", text: "plain output" },
        {
          type: "resource",
          uri: "file:///tmp/result.json",
          mimeType: "application/json",
          data: { ok: true },
        },
      ]),
    ).toBe(
      'plain output\n\n{"type":"resource","uri":"file:///tmp/result.json","mimeType":"application/json","data":{"ok":true}}',
    );
  });

  it("ignores media blocks for text extraction", () => {
    expect(
      extractToolResultText([
        { type: "image", mimeType: "image/png", data: "base64-image-bytes" },
        { type: "image_url", image_url: { url: "data:image/png;base64,preview-bytes" } },
        { type: "audio", mimeType: "audio/mpeg", data: "base64-audio-bytes" },
        { type: "resource", value: "visible" },
      ]),
    ).toBe('{"type":"resource","value":"visible"}');
  });

  it("does not rewrite ordinary structured strings containing data colon substrings", () => {
    expect(
      extractToolResultText([
        { type: "resource", status: "metadata:ready", note: "data: is just prose here" },
      ]),
    ).toBe('{"type":"resource","status":"metadata:ready","note":"data: is just prose here"}');
  });

  it("redacts actual data URI tokens inside structured strings", () => {
    expect(
      extractToolResultText([
        {
          type: "resource",
          preview: "thumbnail=data:image/png;base64,aW1hZ2UtYnl0ZXM= done",
        },
      ]),
    ).toBe('{"type":"resource","preview":"thumbnail=[redacted data URI] done"}');
  });

  it("redacts nested sensitive fields before provider replay", () => {
    expect(
      extractToolResultText([
        {
          type: "resource",
          headers: {
            authorization: "Bearer live-token",
            "x-api-key": "live-api-key",
          },
          token: "nested-token",
        },
      ]),
    ).toBe('{"type":"resource","headers":{"authorization":"***","x-api-key":"***"},"token":"***"}');
  });

  it("omits opaque and binary structured payloads before provider replay", () => {
    expect(
      extractToolResultText([
        {
          type: "resource",
          mimeType: "image/png",
          data: "base64-image-bytes",
          blob: "raw-blob-bytes",
          encrypted_content: "opaque-ciphertext",
        },
      ]),
    ).toBe(
      '{"type":"resource","mimeType":"image/png","data":"[binary omitted: 18 chars]","blob":"[binary omitted: 14 chars]","encrypted_content":"[opaque data omitted: 17 chars]"}',
    );
  });

  it.each([
    ["mime_type", { mime_type: "application/octet-stream" }],
    ["mediaType", { mediaType: "audio/mpeg" }],
    ["contentType", { contentType: "application/pdf" }],
    ["content_type", { content_type: "video/mp4" }],
  ])("treats %s aliases as binary structured payloads", (_label, alias) => {
    expect(
      extractToolResultText([
        {
          type: "resource",
          ...alias,
          data: "binary-payload-bytes",
        },
      ]),
    ).toBe(JSON.stringify({ type: "resource", ...alias, data: "[binary omitted: 20 chars]" }));
  });

  it("handles circular structured payloads without throwing", () => {
    const block: Record<string, unknown> = { type: "resource", value: "visible" };
    block.self = block;

    expect(extractToolResultText([block])).toBe(
      '{"type":"resource","value":"visible","self":"[Circular]"}',
    );
  });

  it("caps large structured payload text before provider replay", () => {
    const text = extractToolResultText([{ type: "resource", data: "x".repeat(9000) }]);

    expect(text).toContain(TRUNCATION_MARKER);
    expect(text.length).toBeLessThan(8100);
  });

  it("caps aggregate provider text after merging many individually bounded blocks", () => {
    const text = extractToolResultText(
      Array.from({ length: 5 }, (_, index) => ({
        type: "resource",
        index,
        data: "x".repeat(3000),
      })),
    );

    expect(text).toContain(TRUNCATION_MARKER);
    expect(text.length).toBeLessThan(8100);
  });

  it("uses the shared truncation helper for aggregate provider text caps", () => {
    const text = extractToolResultText([
      { type: "resource", first: "x".repeat(4000) },
      { type: "resource", second: "y".repeat(4000) },
    ]);

    expect(text).toBe(
      truncateStructuredToolResultText(
        '{"type":"resource","first":"' +
          "x".repeat(4000) +
          '"}\n\n{"type":"resource","second":"' +
          "y".repeat(4000) +
          '"}',
      ),
    );
  });
});
