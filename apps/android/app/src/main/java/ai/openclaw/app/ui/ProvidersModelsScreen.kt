package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelTestResult
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.modelResultKey
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Android provider readiness screen backed by provider-authored model config. */
@Composable
internal fun ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val refreshing by viewModel.modelCatalogRefreshing.collectAsState()
  val errorText by viewModel.modelCatalogErrorText.collectAsState()
  val actionState by viewModel.modelConfigActionState.collectAsState()
  val testResults by viewModel.modelTestResults.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)
  var pendingRemoval by remember { mutableStateOf<GatewayModelSummary?>(null) }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshModelCatalog()
    }
  }

  pendingRemoval?.let { model ->
    AlertDialog(
      onDismissRequest = { pendingRemoval = null },
      title = { Text("Remove model") },
      text = { Text("Remove ${model.provider}/${model.id} from provider model config?") },
      confirmButton = {
        TextButton(
          onClick = {
            viewModel.removeConfiguredModel(provider = model.provider, modelId = model.id)
            pendingRemoval = null
          },
          enabled = !actionState.inFlight,
        ) {
          Text("Remove")
        }
      },
      dismissButton = {
        TextButton(onClick = { pendingRemoval = null }) {
          Text("Cancel")
        }
      },
    )
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 20.dp, top = 13.dp, end = 20.dp, bottom = 6.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(7.dp),
        contentPadding = PaddingValues(bottom = 4.dp),
      ) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              ProviderHeaderIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", onClick = onBack)
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
              Text(text = "Providers & Models", style = ClawTheme.type.display.copy(fontSize = 14.8.sp, lineHeight = 18.sp), color = ClawTheme.colors.text, maxLines = 1)
              Text(
                text = "Review provider-configured model IDs and availability.",
                style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        }

        item {
          ProviderOverviewPanel(
            isConnected = isConnected,
            providerRows = providerRows,
            modelCount = models.size,
            onRefresh = viewModel::refreshModelCatalog,
            refreshing = refreshing,
          )
        }

        item {
          ModelManagementPanel(
            isConnected = isConnected,
            inFlight = actionState.inFlight,
            message = actionState.message,
            onDismissMessage = viewModel::clearModelConfigMessage,
            onConfigureModel = viewModel::configureModel,
          )
        }

        item {
          ProviderSectionLabel(title = "Provider-configured models")
        }

        item {
          if (!isConnected && providerRows.isEmpty()) {
            ClawEmptyState(title = "Gateway offline", body = "Connect your Gateway to load provider model config.")
          } else {
            ProviderList(
              rows = providerRows,
              refreshing = refreshing,
              actionInFlight = actionState.inFlight,
              testResults = testResults,
              onTestModel = viewModel::testConfiguredModel,
              onRemoveModel = { pendingRemoval = it },
            )
          }
        }

        errorText?.let { message ->
          item {
            ClawPanel {
              Text(text = message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            }
          }
        }
      }
    }
  }
}

internal data class ProviderRow(
  val id: String,
  val name: String,
  val status: String,
  val ready: Boolean,
  val modelCount: Int,
  val models: List<GatewayModelSummary> = emptyList(),
)

/** Combines gateway auth-provider readiness with provider-authored model config. */
internal fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): List<ProviderRow> {
  val modelsByProvider = models.groupBy { it.provider.trim().lowercase() }
  val sortedModelsByProvider = modelsByProvider.mapValues { (_, providerModels) -> providerModels.sortedWith(modelComparator) }
  val authRows =
    providers
      .map { provider ->
        val providerModels = sortedModelsByProvider[provider.id.trim().lowercase()].orEmpty()
        val ready = modelProviderReady(provider.status) || providerModels.any { it.available == true }
        ProviderRow(
          id = provider.id,
          name = provider.displayName,
          status = if (ready) "Ready" else "Needs attention",
          ready = ready,
          modelCount = providerModels.size,
          models = providerModels,
        )
      }
  val authProviderIds = authRows.mapTo(mutableSetOf()) { it.id.trim().lowercase() }
  val configuredModelRows =
    sortedModelsByProvider
      .filterKeys { provider -> provider !in authProviderIds }
      .map { (provider, providerModels) ->
        val firstProvider = providerModels.firstOrNull()?.provider?.takeIf { it.isNotBlank() } ?: provider
        val ready = providerModels.any { it.available == true } || providerModels.none { it.available == false }
        ProviderRow(
          id = firstProvider,
          name = providerDisplayName(firstProvider),
          status = if (ready) "Ready" else "Needs attention",
          ready = ready,
          modelCount = providerModels.size,
          models = providerModels,
        )
      }
  return (authRows + configuredModelRows).sortedWith(compareBy(::providerPriority, { it.name.lowercase() }))
}

/** Normalizes gateway provider status strings into a ready/not-ready boolean. */
internal fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" ||
    normalized == "ready" ||
    normalized == "healthy" ||
    normalized == "configured" ||
    normalized == "static"
}

private val modelComparator = compareBy<GatewayModelSummary>({ it.name.lowercase() }, { it.id.lowercase() })

private fun providerPriority(row: ProviderRow): Int = providerPriority(row.id)

private fun providerPriority(provider: String): Int =
  when (provider.trim().lowercase()) {
    "openai" -> 0
    "anthropic" -> 1
    "google" -> 2
    "openrouter" -> 3
    "ollama", "ollama-local" -> 4
    "codex" -> 5
    else -> 100
  }

@Composable
private fun ProviderList(
  rows: List<ProviderRow>,
  refreshing: Boolean,
  actionInFlight: Boolean,
  testResults: Map<String, GatewayModelTestResult>,
  onTestModel: (String, String) -> Unit,
  onRemoveModel: (GatewayModelSummary) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      if (rows.isEmpty()) {
        ProviderListRow(
          row =
            ProviderRow(
              id = "loading",
              name = "Provider catalog",
              status = if (refreshing) "Loading" else "No providers",
              ready = false,
              modelCount = 0,
            ),
          actionInFlight = actionInFlight,
          testResults = testResults,
          onTestModel = onTestModel,
          onRemoveModel = onRemoveModel,
        )
      } else {
        rows.forEachIndexed { index, row ->
          ProviderListRow(
            row = row,
            actionInFlight = actionInFlight,
            testResults = testResults,
            onTestModel = onTestModel,
            onRemoveModel = onRemoveModel,
          )
          if (index != rows.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun ModelManagementPanel(
  isConnected: Boolean,
  inFlight: Boolean,
  message: String?,
  onDismissMessage: () -> Unit,
  onConfigureModel: (String, String, String?) -> Unit,
) {
  var provider by rememberSaveable { mutableStateOf("") }
  var modelId by rememberSaveable { mutableStateOf("") }
  var displayName by rememberSaveable { mutableStateOf("") }
  val canSubmit = isConnected && !inFlight && provider.isNotBlank() && modelId.isNotBlank()

  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
      Text(text = "Configure model", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(
        text = "Add or update a provider model ID. Allowlist-only models are managed outside this screen.",
        style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
        color = ClawTheme.colors.textMuted,
      )
      ClawTextField(value = provider, onValueChange = { provider = it }, placeholder = "Provider, e.g. openai")
      ClawTextField(value = modelId, onValueChange = { modelId = it }, placeholder = "Model ID, e.g. gpt-5.5")
      ClawTextField(value = displayName, onValueChange = { displayName = it }, placeholder = "Display name (optional)")
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        ClawPrimaryButton(
          text = if (inFlight) "Saving" else "Save model",
          onClick = {
            onConfigureModel(provider.trim(), modelId.trim(), displayName.trim().ifEmpty { null })
            modelId = ""
            displayName = ""
          },
          enabled = canSubmit,
          modifier = Modifier.weight(1f),
        )
      }
      message?.let { text ->
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(text = text, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, modifier = Modifier.weight(1f))
          TextButton(onClick = onDismissMessage) {
            Text("Dismiss")
          }
        }
      }
    }
  }
}

@Composable
private fun ProviderOverviewPanel(
  isConnected: Boolean,
  providerRows: List<ProviderRow>,
  modelCount: Int,
  refreshing: Boolean,
  onRefresh: () -> Unit,
) {
  val readyCount = providerRows.count { it.ready }
  val needsSetupCount = providerRows.count { !it.ready }
  ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ProviderMetricTile(label = "Ready", value = readyCount.toString(), modifier = Modifier.weight(1f))
        ProviderMetricTile(label = "Models", value = modelCount.toString(), modifier = Modifier.weight(1f))
        ProviderMetricTile(label = "Needs", value = needsSetupCount.toString(), modifier = Modifier.weight(1f))
      }
      Text(
        text = if (isConnected) "Refresh to load provider model config and readiness from your Gateway." else "Connect your Gateway to view provider model config.",
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(text = if (refreshing) "Refreshing" else "Refresh", onClick = onRefresh, enabled = isConnected && !refreshing, modifier = Modifier.fillMaxWidth())
    }
  }
}

@Composable
private fun ProviderMetricTile(
  label: String,
  value: String,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier,
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.text,
  ) {
    Column(modifier = Modifier.padding(horizontal = 9.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(text = value, style = ClawTheme.type.title, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
    }
  }
}

@Composable
private fun ProviderListRow(
  row: ProviderRow,
  actionInFlight: Boolean,
  testResults: Map<String, GatewayModelTestResult>,
  onTestModel: (String, String) -> Unit,
  onRemoveModel: (GatewayModelSummary) -> Unit,
) {
  Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ProviderBadge(text = row.name)
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = row.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = if (row.modelCount > 0) "${row.modelCount} provider models" else "No provider model IDs", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      ProviderStatusPill(ready = row.ready, status = row.status)
    }
    if (row.models.isNotEmpty()) {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        row.models.forEach { model ->
          ProviderModelRow(
            model = model,
            testResult = testResults[modelResultKey(model.provider, model.id)],
            actionInFlight = actionInFlight,
            onTest = { onTestModel(model.provider, model.id) },
            onRemove = { onRemoveModel(model) },
          )
        }
      }
    }
  }
}

@Composable
private fun ProviderModelRow(
  model: GatewayModelSummary,
  testResult: GatewayModelTestResult?,
  actionInFlight: Boolean,
  onTest: () -> Unit,
  onRemove: () -> Unit,
) {
  Surface(shape = RoundedCornerShape(ClawTheme.radii.row), color = ClawTheme.colors.surface, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(text = model.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(text = model.id, style = ClawTheme.type.caption.copy(fontSize = 12.2.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        ModelAvailabilityPill(model = model, testResult = testResult)
      }
      val caps = modelCapabilities(model)
      if (caps.isNotEmpty()) {
        Text(text = caps, style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp), color = ClawTheme.colors.textSubtle, maxLines = 2, overflow = TextOverflow.Ellipsis)
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ClawSecondaryButton(text = "Test", onClick = onTest, enabled = !actionInFlight, modifier = Modifier.weight(1f))
        ClawSecondaryButton(text = "Remove", onClick = onRemove, enabled = !actionInFlight, modifier = Modifier.weight(1f))
      }
    }
  }
}

@Composable
private fun ProviderStatusPill(
  ready: Boolean,
  status: String,
) {
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
    Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (ready) ClawTheme.colors.success else ClawTheme.colors.warning))
    Text(text = status, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
  }
}

@Composable
private fun ModelAvailabilityPill(
  model: GatewayModelSummary,
  testResult: GatewayModelTestResult?,
) {
  val label = testResult?.status ?: modelAvailabilityLabel(model.available)
  val ready = testResult?.available ?: model.available
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
    Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(availabilityColor(ready)))
    Text(text = label, style = ClawTheme.type.caption.copy(fontSize = 12.2.sp, lineHeight = 15.sp), color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}

@Composable
private fun availabilityColor(available: Boolean?): Color =
  when (available) {
    true -> ClawTheme.colors.success
    false -> ClawTheme.colors.warning
    null -> ClawTheme.colors.textSubtle
  }

private fun modelAvailabilityLabel(available: Boolean?): String =
  when (available) {
    true -> "Available"
    false -> "Unavailable"
    null -> "Unknown"
  }

private fun modelCapabilities(model: GatewayModelSummary): String =
  buildList {
    if (model.supportsReasoning) add("reasoning")
    if (model.supportsVision) add("image")
    if (model.supportsAudio) add("audio")
    if (model.supportsDocuments) add("document")
    model.contextTokens?.let { add("${formatContextTokens(it)} context") }
  }.joinToString(" / ")

private fun formatContextTokens(tokens: Long): String = if (tokens >= 1_000) "${tokens / 1_000}k" else tokens.toString()

@Composable
private fun ProviderBadge(text: String) {
  Surface(modifier = Modifier.size(30.dp), shape = RoundedCornerShape(ClawTheme.radii.row), color = ClawTheme.colors.surfacePressed, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = providerInitials(text), style = ClawTheme.type.label, color = ClawTheme.colors.text, textAlign = TextAlign.Center)
    }
  }
}

private fun providerInitials(value: String): String =
  value
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "AI" }

@Composable
private fun ProviderSectionLabel(title: String) {
  Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
  }
}

@Composable
private fun ProviderHeaderIconButton(
  icon: ImageVector,
  contentDescription: String,
  outlined: Boolean = false,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(ClawTheme.spacing.touchTarget),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = if (outlined) BorderStroke(1.dp, ClawTheme.colors.borderStrong) else null,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(if (outlined) 17.dp else 20.dp))
    }
  }
}
