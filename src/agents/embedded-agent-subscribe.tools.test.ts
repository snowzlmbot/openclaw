import { describe, expect, it } from "vitest";
import { extractToolResultText } from "./embedded-agent-subscribe.tools.js";

describe("extractToolResultText", () => {
  it("serializes structured non-image tool result blocks for visible output", () => {
    const text = extractToolResultText({
      content: [
        { type: "json", data: { status: "ok", value: 42 } },
        { type: "resource", resource: { uri: "file:///tmp/result.json", text: "payload" } },
      ],
    });

    expect(text).toContain('"type":"json"');
    expect(text).toContain('"status":"ok"');
    expect(text).toContain('"type":"resource"');
    expect(text).not.toContain("see attached image");
  });

  it("keeps existing text blocks and skips image blocks", () => {
    const text = extractToolResultText({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
    });

    expect(text).toBe("hello");
  });
});
