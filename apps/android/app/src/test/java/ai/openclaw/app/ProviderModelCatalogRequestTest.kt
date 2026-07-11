package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class ProviderModelCatalogRequestTest {
  @Test
  fun fallsBackToConfiguredViewWhenGatewayRejectsProviderConfigView() =
    runBlocking {
      val requests = mutableListOf<String>()

      val response =
        requestProviderModelConfig { paramsJson ->
          requests += paramsJson
          if (requests.size == 1) {
            throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unsupported view"))
          }
          "configured-response"
        }

      assertEquals("configured-response", response)
      assertEquals(
        listOf("""{"view":"provider-config"}""", """{"view":"configured"}"""),
        requests,
      )
    }

  @Test
  fun preservesNonCompatibilityGatewayFailures() =
    runBlocking {
      val expected = GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "gateway busy"))
      var actual: Throwable? = null

      try {
        requestProviderModelConfig { throw expected }
      } catch (err: Throwable) {
        actual = err
      }

      assertSame(expected, actual)
    }
}
