/** Resolves optional startup SecretRefs without weakening required credential failures. */
import { formatErrorMessage } from "../infra/errors.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { secretRefKey } from "./ref-contract.js";
import { isMissingSecretRefResolutionError, resolveSecretRefValues } from "./resolve.js";
import {
  applyResolvedAssignments,
  pushWarning,
  type ResolverContext,
  type SecretAssignment,
} from "./runtime-shared.js";

type SecretResolutionOptions = Parameters<typeof resolveSecretRefValues>[1];

function splitSecretAssignments(
  assignments: SecretAssignment[],
  allowUnavailableOptionalAssignments: boolean,
): {
  required: SecretAssignment[];
  optional: SecretAssignment[];
} {
  const required: SecretAssignment[] = [];
  const optional: SecretAssignment[] = [];
  for (const assignment of assignments) {
    if (allowUnavailableOptionalAssignments && assignment.optional) {
      optional.push(assignment);
      continue;
    }
    required.push(assignment);
  }
  return { required, optional };
}

function warnOptionalSecretUnavailable(params: {
  assignment: SecretAssignment;
  context: ResolverContext;
  error: unknown;
}): void {
  const refLabel = secretRefKey(params.assignment.ref);
  const message = [
    `${params.assignment.path}: optional SecretRef "${refLabel}" is unavailable; ` +
      "leaving this capability configured-unavailable until the SecretRef resolves.",
    params.assignment.optionalReason,
    formatErrorMessage(params.error),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  pushWarning(params.context, {
    code: "SECRETS_REF_UNAVAILABLE_OPTIONAL",
    path: params.assignment.path,
    message,
  });
}

function registerResolvedValuesForRedaction(resolved: ReadonlyMap<string, unknown>): void {
  for (const value of resolved.values()) {
    if (typeof value === "string") {
      registerSecretValueForRedaction(value);
    }
  }
}

function isOptionalSecretUnavailableError(params: {
  assignment: SecretAssignment;
  error: unknown;
}): boolean {
  return isMissingSecretRefResolutionError({
    ref: params.assignment.ref,
    error: params.error,
  });
}

export async function resolveAndApplySecretAssignments(params: {
  assignments: SecretAssignment[];
  context: ResolverContext;
  options: SecretResolutionOptions;
  allowUnavailableOptionalAssignments?: boolean;
}): Promise<void> {
  const { required, optional } = splitSecretAssignments(
    params.assignments,
    params.allowUnavailableOptionalAssignments === true,
  );
  if (required.length > 0) {
    const resolved = await resolveSecretRefValues(
      required.map((assignment) => assignment.ref),
      params.options,
    );
    registerResolvedValuesForRedaction(resolved);
    applyResolvedAssignments({ assignments: required, resolved });
  }

  for (const assignment of optional) {
    let resolved: Awaited<ReturnType<typeof resolveSecretRefValues>>;
    try {
      // Resolve optional refs independently so one missing provider key does not mask another.
      resolved = await resolveSecretRefValues([assignment.ref], params.options);
    } catch (error) {
      if (!isOptionalSecretUnavailableError({ assignment, error })) {
        throw error;
      }
      // Preserve the unresolved SecretRef in the runtime config. Removing it would
      // reactivate provider env/profile fallbacks and could route data to another account.
      warnOptionalSecretUnavailable({ assignment, context: params.context, error });
      continue;
    }
    registerResolvedValuesForRedaction(resolved);
    applyResolvedAssignments({ assignments: [assignment], resolved });
  }
}
