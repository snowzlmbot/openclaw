import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { normalizeAccountId } from "../../routing/session-key.js";

const CURRENT_SOURCE_REPLY_ROUTE = "current-source";

type SendActionResult = {
  kind: string;
  payload?: unknown;
  toolResult?: AgentToolResult<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function markCurrentSourceReplyResult<T extends SendActionResult>(result: T): T {
  if (result.kind !== "send") {
    return result;
  }
  const payload = asRecord(result.payload);
  const details = asRecord(result.toolResult?.details);
  return {
    ...result,
    payload: payload
      ? { ...payload, sourceReplyRoute: CURRENT_SOURCE_REPLY_ROUTE }
      : result.payload,
    ...(result.toolResult
      ? {
          toolResult: {
            ...result.toolResult,
            details: { ...details, sourceReplyRoute: CURRENT_SOURCE_REPLY_ROUTE },
          },
        }
      : {}),
  } as T;
}

export type CurrentSourceReplyRouteParams = Parameters<typeof isCurrentSourceReplyRoute>[0];

export function markCurrentSourceReplyResultIfNeeded<T extends SendActionResult>(
  result: T,
  params: CurrentSourceReplyRouteParams,
): T {
  return isCurrentSourceReplyRoute(params) ? markCurrentSourceReplyResult(result) : result;
}

export function isExplicitDifferentAccount(params: {
  explicitAccountId: unknown;
  currentAccountId: unknown;
}): boolean {
  const explicitAccountId = normalizeOptionalString(params.explicitAccountId);
  if (!explicitAccountId) {
    return false;
  }
  const currentAccountId = normalizeOptionalString(params.currentAccountId);
  return (
    !currentAccountId ||
    normalizeAccountId(explicitAccountId) !== normalizeAccountId(currentAccountId)
  );
}

export function isExplicitDifferentChannel(params: {
  explicitChannel: unknown;
  currentChannelProvider: unknown;
}): boolean {
  const explicitChannel = normalizeOptionalString(params.explicitChannel)?.toLowerCase();
  if (!explicitChannel) {
    return false;
  }
  const currentChannel = normalizeOptionalString(params.currentChannelProvider)?.toLowerCase();
  return !currentChannel || explicitChannel !== currentChannel;
}

export function hasExplicitMessageTarget(params: Record<string, unknown>): boolean {
  return (
    [params.target, params.to, params.channelId].some((value) =>
      Boolean(normalizeOptionalString(value)),
    ) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => Boolean(normalizeOptionalString(value))))
  );
}

export function shouldApplyImplicitSourceReplySendPolicy(params: {
  action: string;
  sourceReplyDeliveryMode: unknown;
  hasExplicitNonCurrentChannel: boolean;
  hasExplicitDifferentAccount: boolean;
  hasExplicitTarget: boolean;
  targetMatchesCurrentSource: boolean;
}): boolean {
  return (
    params.action === "send" &&
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    !params.hasExplicitNonCurrentChannel &&
    !params.hasExplicitDifferentAccount &&
    (!params.hasExplicitTarget || params.targetMatchesCurrentSource)
  );
}

export function isCurrentSourceReplyRoute(params: {
  dryRun: boolean;
  currentChannelProvider: unknown;
  actionChannel: unknown;
  currentAccountId: unknown;
  explicitAccountId: unknown;
  targetMatchesCurrentSource: boolean;
  currentThreadId: unknown;
  resolvedThreadId: unknown;
  replyToIsExplicit: boolean;
}): boolean {
  const currentChannel = normalizeOptionalString(params.currentChannelProvider)?.toLowerCase();
  const actionChannel = normalizeOptionalString(params.actionChannel)?.toLowerCase();
  if (
    params.dryRun ||
    !currentChannel ||
    (actionChannel && actionChannel !== currentChannel) ||
    isExplicitDifferentAccount({
      explicitAccountId: params.explicitAccountId,
      currentAccountId: params.currentAccountId,
    }) ||
    !params.targetMatchesCurrentSource
  ) {
    return false;
  }
  const currentThreadId = normalizeOptionalString(params.currentThreadId);
  const resolvedThreadId = normalizeOptionalString(params.resolvedThreadId);
  if (params.replyToIsExplicit && actionChannel === "slack" && !currentThreadId) {
    return false;
  }
  return currentThreadId ? resolvedThreadId === currentThreadId : !resolvedThreadId;
}
