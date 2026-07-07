package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionKeyTest {
  @Test
  fun buildOpenClawAppSessionKeyUsesStableDeviceScopedSuffix() {
    val key = buildOpenClawAppSessionKey(deviceId = "1234567890abcdef", agentId = "ops")

    assertEquals("agent:ops:openclaw-app-1234567890ab", key)
  }

  @Test
  fun buildOpenClawAppSessionKeyDefaultsToMainAgent() {
    val key = buildOpenClawAppSessionKey(deviceId = "1234567890abcdef", agentId = " ")

    assertEquals("agent:main:openclaw-app-1234567890ab", key)
  }

  @Test
  fun buildOpenClawAppSessionLabelIncludesDeviceDisplayName() {
    assertEquals("OpenClaw App", buildOpenClawAppSessionLabel(null))
    assertEquals("OpenClaw App · Pixel", buildOpenClawAppSessionLabel(" Pixel "))
  }

  @Test
  fun resolveAgentIdFromMainSessionKeyParsesCanonicalAgentKey() {
    assertEquals("ops", resolveAgentIdFromMainSessionKey("agent:ops:main"))
    assertNull(resolveAgentIdFromMainSessionKey("global"))
  }
}
