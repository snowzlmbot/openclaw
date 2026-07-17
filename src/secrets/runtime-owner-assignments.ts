/** Resolves SecretRef assignments atomically by owning runtime surface. */
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { secretRefKey } from "./ref-contract.js";
import { describeSecretResolutionError } from "./resolve-errors.js";
import { resolveSecretRefValues } from "./resolve.js";
import type { DegradedSecretOwner } from "./runtime-degraded-state.js";
import {
  applyResolvedAssignments,
  pushWarning,
  type ResolverContext,
  type SecretAssignment,
} from "./runtime-shared.js";

type SecretResolutionOptions = Parameters<typeof resolveSecretRefValues>[1];

function registerResolvedValuesForRedaction(resolved: ReadonlyMap<string, unknown>): void {
  for (const value of resolved.values()) {
    if (typeof value === "string") {
      registerSecretValueForRedaction(value);
    }
  }
}

function assignmentOwnerKey(assignment: SecretAssignment): string {
  return `${assignment.ownerKind}\0${assignment.ownerId}`;
}

function groupAssignmentsByOwner(assignments: SecretAssignment[]): SecretAssignment[][] {
  const groups = new Map<string, SecretAssignment[]>();
  for (const assignment of assignments) {
    const key = assignmentOwnerKey(assignment);
    const group = groups.get(key);
    if (group) {
      const owner = group[0]!;
      if (
        owner.requiredForGateway !== assignment.requiredForGateway ||
        owner.disposition !== assignment.disposition
      ) {
        throw new Error(
          `Secret owner ${assignment.ownerKind}:${assignment.ownerId} has conflicting assignment policy.`,
        );
      }
      group.push(assignment);
      continue;
    }
    groups.set(key, [assignment]);
  }
  return [...groups.values()];
}

function createDegradedOwner(assignments: SecretAssignment[], reason: string): DegradedSecretOwner {
  const owner = assignments[0]!;
  if (owner.ownerKind === "unknown") {
    throw new Error(`Secret assignment ${owner.path} has no runtime owner.`);
  }
  return {
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: "unavailable",
    paths: assignments.map((assignment) => assignment.path),
    refKeys: assignments.map((assignment) => secretRefKey(assignment.ref)),
    reason,
  };
}

function warnDegradedOwner(context: ResolverContext, owner: DegradedSecretOwner): void {
  pushWarning(context, {
    code: "SECRETS_OWNER_UNAVAILABLE",
    path: owner.paths[0]!,
    message:
      `Secret owner ${owner.ownerKind}:${owner.ownerId} is configured-unavailable; ` +
      `paths: ${owner.paths.join(", ")}; reason: ${owner.reason}.`,
  });
}

async function resolveStrictAssignments(params: {
  assignments: SecretAssignment[];
  options: SecretResolutionOptions;
}): Promise<void> {
  const resolved = await resolveSecretRefValues(
    params.assignments.map((assignment) => assignment.ref),
    params.options,
  );
  registerResolvedValuesForRedaction(resolved);
  applyResolvedAssignments({ assignments: params.assignments, resolved });
}

export async function resolveAndApplySecretAssignments(params: {
  assignments: SecretAssignment[];
  context: ResolverContext;
  options: SecretResolutionOptions;
  allowOwnerIsolation?: boolean;
}): Promise<DegradedSecretOwner[]> {
  if (!params.allowOwnerIsolation) {
    await resolveStrictAssignments(params);
    return [];
  }

  const degradedOwners: DegradedSecretOwner[] = [];
  for (const assignments of groupAssignmentsByOwner(params.assignments)) {
    try {
      await resolveStrictAssignments({ assignments, options: params.options });
    } catch (error) {
      const owner = assignments[0]!;
      const reason = describeSecretResolutionError(error);
      if (
        !reason ||
        owner.ownerKind === "unknown" ||
        owner.requiredForGateway ||
        owner.disposition === "fail-closed"
      ) {
        throw error;
      }
      // Leave the explicit SecretRefs in runtime config. Applying another credential source here
      // would silently route this owner through env/profile fallback after its declared ref failed.
      const degradedOwner = createDegradedOwner(assignments, reason);
      degradedOwners.push(degradedOwner);
      warnDegradedOwner(params.context, degradedOwner);
    }
  }
  return degradedOwners;
}
