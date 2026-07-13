import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";

type RuntimeSecretsActivationReason = "startup" | "reload" | "restart-check";

export function hasActiveGatewayAuthSecretRef(config: OpenClawConfig): boolean {
  const states = evaluateGatewayAuthSurfaceStates({
    config,
    defaults: config.secrets?.defaults,
    env: process.env,
  });
  return GATEWAY_AUTH_SURFACE_PATHS.some((path) => {
    const state = states[path];
    return state.hasSecretRef && state.active;
  });
}

export function logGatewayAuthSurfaceDiagnostics(
  prepared: {
    sourceConfig: OpenClawConfig;
    warnings: Array<{ code: string; path: string; message: string }>;
  },
  logSecrets: { info: (message: string) => void },
): void {
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,
  });
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;
    }
    const stateLabel = state.active ? "active" : "inactive";
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

export function pruneSkippedStartupSecretSurfaces(config: OpenClawConfig): OpenClawConfig {
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels || !config.channels) {
    return config;
  }
  return {
    ...config,
    channels: undefined,
  };
}

export function pruneSuppressedStartupChannelAssignments(
  config: OpenClawConfig,
  activationParams: { reason: RuntimeSecretsActivationReason },
  channelAutostartSuppression?: { reason: string; message: string } | null,
): OpenClawConfig {
  if (
    activationParams.reason !== "startup" ||
    channelAutostartSuppression == null ||
    !config.channels
  ) {
    return config;
  }
  // Preserve the complete source config for recovery while excluding channel
  // assignments from the startup projection that may contain unavailable refs.
  return {
    ...config,
    channels: undefined,
  };
}
