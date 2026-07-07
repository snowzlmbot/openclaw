package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.modelResultKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelStatusTest {
  @Test
  fun staticProviderStatusIsReady() {
    assertTrue(modelProviderReady("static"))
  }

  @Test
  fun expiringProviderStatusIsNotFullyReady() {
    assertFalse(modelProviderReady("expiring"))
  }

  @Test
  fun missingProviderStatusIsNotReady() {
    assertFalse(modelProviderReady("missing"))
  }

  @Test
  fun providerRowsIncludeConfiguredModelProvidersWithoutAuthRows() {
    val rows =
      providerRows(
        providers =
          listOf(
            GatewayModelProviderSummary(
              id = "openai",
              displayName = "OpenAI",
              status = "ok",
              profileCount = 1,
            ),
          ),
        models =
          listOf(
            model(provider = "openai", id = "gpt-5.5"),
            model(provider = "byteplus", id = "seed-1-8-251228"),
          ),
      )

    assertEquals(listOf("openai", "byteplus"), rows.map { it.id })
    assertEquals(1, rows.first { it.id == "openai" }.modelCount)
    assertEquals(1, rows.first { it.id == "byteplus" }.modelCount)
    assertEquals(listOf("gpt-5.5"), rows.first { it.id == "openai" }.models.map { it.id })
    assertEquals(listOf("seed-1-8-251228"), rows.first { it.id == "byteplus" }.models.map { it.id })
    assertTrue(rows.first { it.id == "byteplus" }.ready)
  }

  @Test
  fun providerRowsMarkConfiguredProviderWithUnavailableModelsAsNeedsAttention() {
    val rows =
      providerRows(
        providers = emptyList(),
        models = listOf(model(provider = "custom", id = "offline-model", available = false)),
      )

    assertEquals(1, rows.size)
    assertEquals("custom", rows.single().id)
    assertFalse(rows.single().ready)
    assertEquals("Needs attention", rows.single().status)
  }

  @Test
  fun modelResultKeyNormalizesProviderOnly() {
    assertEquals("openai/GPT-5.5", modelResultKey(" OpenAI ", "GPT-5.5"))
  }

  private fun model(
    provider: String,
    id: String,
    available: Boolean? = null,
  ): GatewayModelSummary =
    GatewayModelSummary(
      id = id,
      name = id,
      provider = provider,
      supportsVision = false,
      supportsAudio = false,
      supportsDocuments = false,
      supportsReasoning = false,
      contextTokens = null,
      available = available,
    )
}
