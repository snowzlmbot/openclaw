import { truncateUtf16Safe } from "../shared/utf16-slice.js";
import { redactSensitiveFieldValue, redactToolPayloadText } from "./redact.js";

type DataUriRedactionMode = "inline" | "tokens";

type SerializeStructuredToolResultOptions = {
  maxChars?: number;
  dataUriRedaction?: DataUriRedactionMode;
  skipTypes?: readonly string[];
};

export const DEFAULT_STRUCTURED_TOOL_RESULT_MAX_CHARS = 8000;
const DATA_URI_TOKEN_RE =
  /\bdata:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^\s"'<>;,]+)*(?:;base64)?,[^\s"'<>]+/gi;
const REDACTED_DATA_URI = "[redacted data URI]";
const OPAQUE_STRUCTURED_RESULT_FIELDS = new Set(["encryptedcontent", "encryptedstdout"]);
const SENSITIVE_STRUCTURED_FIELD_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xapikey",
  "xauthtoken",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "password",
  "privatekey",
  "secret",
  "token",
]);

export function serializeStructuredToolResultBlock(
  block: unknown,
  options: SerializeStructuredToolResultOptions = {},
): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  const type = readLowercaseString(record.type);
  if (type && shouldSkipStructuredToolResultType(type, options.skipTypes)) {
    return undefined;
  }

  try {
    const maxChars = options.maxChars ?? DEFAULT_STRUCTURED_TOOL_RESULT_MAX_CHARS;
    const serialized = JSON.stringify(
      sanitizeStructuredToolResultValue(record, {
        dataUriRedaction: options.dataUriRedaction ?? "tokens",
        maxChars,
      }),
    );
    const redacted = serialized ? redactToolPayloadText(serialized) : serialized;
    const truncated = redacted ? truncateStructuredToolResultText(redacted, maxChars) : redacted;
    return truncated && truncated !== "{}" ? truncated : undefined;
  } catch {
    return undefined;
  }
}

export function stringifyProviderToolTextValue(
  value: unknown,
  maxChars = DEFAULT_STRUCTURED_TOOL_RESULT_MAX_CHARS,
): string {
  if (typeof value === "string") {
    return truncateStructuredToolResultText(redactDataUriTokens(value), maxChars);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  return "";
}

function sanitizeStructuredToolResultValue(
  value: unknown,
  options: Required<Pick<SerializeStructuredToolResultOptions, "dataUriRedaction" | "maxChars">>,
  key = "",
  parentCarriesBinaryData = false,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return sanitizeStructuredString(value, key, parentCarriesBinaryData, options);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) =>
      sanitizeStructuredToolResultValue(item, options, key, parentCarriesBinaryData, seen),
    );
    seen.delete(value);
    return out;
  }

  const record = value as Record<string, unknown>;
  const hasBinaryData = carriesBinaryData(record);
  const out = Object.fromEntries(
    Object.entries(record).map(([childKey, child]) => [
      childKey,
      sanitizeStructuredToolResultValue(child, options, childKey, hasBinaryData, seen),
    ]),
  );
  seen.delete(value);
  return out;
}

function sanitizeStructuredString(
  value: string,
  key: string,
  parentCarriesBinaryData: boolean,
  options: Required<Pick<SerializeStructuredToolResultOptions, "dataUriRedaction" | "maxChars">>,
): string {
  const normalizedKey = normalizeStructuredKey(key);
  if (SENSITIVE_STRUCTURED_FIELD_KEYS.has(normalizedKey)) {
    return "***";
  }
  if (OPAQUE_STRUCTURED_RESULT_FIELDS.has(normalizedKey)) {
    return `[opaque data omitted: ${value.length} chars]`;
  }
  if (normalizedKey === "blob" || (normalizedKey === "data" && parentCarriesBinaryData)) {
    return `[binary omitted: ${value.length} chars]`;
  }

  const redacted = redactSensitiveFieldValue(key, value);
  const dataUriRedacted =
    options.dataUriRedaction === "inline"
      ? redactInlineDataUriValue(redacted)
      : redactDataUriTokens(redacted);
  return truncateStructuredToolResultText(dataUriRedacted, options.maxChars);
}

function carriesBinaryData(record: Record<string, unknown>): boolean {
  const type = readLowercaseString(record.type);
  if (type === "audio" || type === "image" || type === "base64") {
    return true;
  }
  const mediaType = readLowercaseString(
    record.media_type ??
      record.mime_type ??
      record.mimeType ??
      record.mediaType ??
      record.contentType ??
      record.content_type,
  );
  return (
    mediaType?.startsWith("image/") === true ||
    mediaType?.startsWith("audio/") === true ||
    mediaType?.startsWith("video/") === true ||
    mediaType === "application/pdf" ||
    mediaType === "application/octet-stream"
  );
}

function readLowercaseString(value: unknown): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function shouldSkipStructuredToolResultType(
  type: string,
  skipTypes: readonly string[] | undefined,
): boolean {
  return skipTypes?.some((skipType) => skipType.toLowerCase() === type) === true;
}

function normalizeStructuredKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function truncateStructuredToolResultText(
  text: string,
  maxChars = DEFAULT_STRUCTURED_TOOL_RESULT_MAX_CHARS,
): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${truncateUtf16Safe(text, maxChars)}\n…(truncated)…`;
}

function redactInlineDataUriValue(value: string): string {
  const trimmed = value.trimStart();
  if (!trimmed.toLowerCase().startsWith("data:")) {
    return value;
  }
  return `[inline data URI: ${value.length} chars]`;
}

function redactDataUriTokens(value: string): string {
  return value.replace(DATA_URI_TOKEN_RE, REDACTED_DATA_URI);
}
