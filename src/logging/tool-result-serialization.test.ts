import { describe, expect, it } from "vitest";
import { serializeStructuredToolResultBlock } from "./tool-result-serialization.js";

describe("serializeStructuredToolResultBlock", () => {
  it.each([
    ["media_type", { media_type: "image/png" }],
    ["mime_type", { mime_type: "application/octet-stream" }],
    ["mimeType", { mimeType: "application/pdf" }],
    ["mediaType", { mediaType: "audio/mpeg" }],
    ["contentType", { contentType: "application/pdf" }],
    ["content_type", { content_type: "video/mp4" }],
  ])("omits binary data for %s media aliases", (_label, alias) => {
    expect(
      serializeStructuredToolResultBlock({
        type: "resource",
        ...alias,
        data: "binary-payload-bytes",
      }),
    ).toBe(JSON.stringify({ type: "resource", ...alias, data: "[binary omitted: 20 chars]" }));
  });
});
