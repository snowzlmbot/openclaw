import {
  serializeStructuredToolResultBlock,
  stringifyProviderToolTextValue,
  truncateStructuredToolResultText,
} from "../../logging/tool-result-serialization.js";

type ToolResultContentBlock = {
  type?: string;
  text?: unknown;
  [key: string]: unknown;
};

const MEDIA_TOOL_RESULT_TYPES = new Set(["image", "image_url", "audio"]);

export function extractToolResultText(content: readonly unknown[]): string {
  const chunks: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) {
      const text = stringifyProviderToolTextValue(part);
      if (text.length > 0) {
        chunks.push(text);
      }
      continue;
    }

    if (typeof part.type === "string" && MEDIA_TOOL_RESULT_TYPES.has(part.type)) {
      continue;
    }

    if (part.type === "text") {
      const text = stringifyProviderToolTextValue(part.text);
      if (text.length > 0) {
        chunks.push(text);
      }
      continue;
    }

    const serialized = serializeStructuredToolResultBlock(part);
    if (serialized) {
      chunks.push(serialized);
    }
  }

  return truncateStructuredToolResultText(chunks.join("\n\n"));
}

function isRecord(value: unknown): value is ToolResultContentBlock {
  return typeof value === "object" && value !== null;
}
