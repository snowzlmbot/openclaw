package ai.openclaw.app

/** Normalizes blank gateway session keys to the legacy main session alias. */
internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim()
  return if (!trimmed.isNullOrEmpty()) trimmed else "main"
}

/** Extracts the agent id from canonical agent-scoped main session keys. */
internal fun resolveAgentIdFromMainSessionKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  if (!trimmed.startsWith("agent:")) return null
  return trimmed
    .removePrefix("agent:")
    .substringBefore(':')
    .trim()
    .ifEmpty { null }
}

private const val OPENCLAW_APP_SESSION_LABEL = "OpenClaw App"

private fun normalizeAgentIdForSessionKey(agentId: String?): String =
  agentId?.trim().orEmpty().ifEmpty { "main" }

/** Builds the Android app-owned chat session key consumed by gateway chat and presence APIs. */
internal fun buildOpenClawAppSessionKey(
  deviceId: String,
  agentId: String?,
): String {
  val resolvedAgentId = normalizeAgentIdForSessionKey(agentId)
  return "agent:$resolvedAgentId:openclaw-app-${deviceId.take(12)}"
}

/** Human-readable label applied when the Android app creates/adopts its dedicated session. */
internal fun buildOpenClawAppSessionLabel(displayName: String?): String {
  val suffix =
    displayName
      ?.trim()
      ?.take(96)
      ?.takeIf { it.isNotEmpty() }
      ?: return OPENCLAW_APP_SESSION_LABEL
  return "$OPENCLAW_APP_SESSION_LABEL · $suffix"
}
