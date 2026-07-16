/** Private metadata for SecretRefs that may be unavailable during cold startup. */

// Symbol.for keeps the marker stable across test/runtime module reloads without exposing it in the
// Plugin SDK assignment type. Enumeration and serialization must continue to see the old shape.
const OPTIONAL_ASSIGNMENT_REASON = Symbol.for("openclaw.secrets.optionalAssignmentReason");

export function markSecretAssignmentOptional(assignment: object, reason: string): void {
  Object.defineProperty(assignment, OPTIONAL_ASSIGNMENT_REASON, {
    configurable: true,
    value: reason,
  });
}

export function getOptionalSecretAssignmentReason(assignment: object): string | undefined {
  const reason = Reflect.get(assignment, OPTIONAL_ASSIGNMENT_REASON);
  return typeof reason === "string" ? reason : undefined;
}
