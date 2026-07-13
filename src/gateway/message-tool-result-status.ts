import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readMaybeJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return asRecord(value);
  }
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function isDryRunMessageToolRecord(record: Record<string, unknown>): boolean {
  if (record.dryRun === true || record.dry_run === true) {
    return true;
  }
  const status =
    normalizeOptionalString(record.deliveryStatus) ??
    normalizeOptionalString(record.delivery_status) ??
    normalizeOptionalString(record.status);
  return status?.toLowerCase() === "dry_run";
}

export function hasDryRunMessageToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record && isDryRunMessageToolRecord(record)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasDryRunMessageToolResultValue(block)) {
      return true;
    }
    const blockRecord = asRecord(block);
    return (
      hasDryRunMessageToolResultValue(blockRecord?.text) ||
      hasDryRunMessageToolResultValue(blockRecord?.content)
    );
  });
}

export function readMessageToolResultName(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    normalizeOptionalString(message.name) ??
    normalizeOptionalString(message.tool)
  );
}

export function readMessageToolResultCallId(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolCallId) ??
    normalizeOptionalString(message.tool_call_id) ??
    normalizeOptionalString(message.callId) ??
    normalizeOptionalString(message.call_id) ??
    normalizeOptionalString(message.id)
  );
}

export function readMessageToolResultOkValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const record = readMaybeJsonRecord(value);
  if (record && typeof record.ok === "boolean") {
    return record.ok;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const block of value) {
    const blockOk = readMessageToolResultOkValue(block);
    if (blockOk !== undefined) {
      return blockOk;
    }
    const blockRecord = asRecord(block);
    const textOk = readMessageToolResultOkValue(blockRecord?.text);
    if (textOk !== undefined) {
      return textOk;
    }
    const contentOk = readMessageToolResultOkValue(blockRecord?.content);
    if (contentOk !== undefined) {
      return contentOk;
    }
  }
  return undefined;
}

export function hasSuppressedMessageToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record) {
    const messageId = normalizeOptionalString(record.messageId)?.toLowerCase();
    const status =
      normalizeOptionalString(record.deliveryStatus)?.toLowerCase() ??
      normalizeOptionalString(record.delivery_status)?.toLowerCase() ??
      normalizeOptionalString(record.status)?.toLowerCase();
    if (
      record.delivered === false ||
      messageId === "skipped" ||
      messageId === "suppressed" ||
      status === "skipped" ||
      status === "suppressed"
    ) {
      return true;
    }
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasSuppressedMessageToolResultValue(block)) {
      return true;
    }
    const blockRecord = asRecord(block);
    return (
      hasSuppressedMessageToolResultValue(blockRecord?.text) ||
      hasSuppressedMessageToolResultValue(blockRecord?.content)
    );
  });
}

export function readMessageToolSourceReplyRoute(
  message: Record<string, unknown>,
): "current-source" | undefined {
  return asRecord(message.details)?.sourceReplyRoute === "current-source"
    ? "current-source"
    : undefined;
}
