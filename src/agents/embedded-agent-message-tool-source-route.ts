function normalizeStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isBareOkDeliveryStatus(value: unknown): boolean {
  return normalizeStatus(value) === "ok";
}

export function isBareSentDeliveryStatus(value: unknown): boolean {
  return normalizeStatus(value) === "sent";
}

export function resultConfirmsCurrentSourceRoute(value: unknown): boolean {
  return asRecord(asRecord(value).details).sourceReplyRoute === "current-source";
}
