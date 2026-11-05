package com.yansuu1.jizhang.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialConfigResponse
import com.yansuu1.jizhang.repo.FinancialConfigUpdateResponse
import com.yansuu1.jizhang.repo.FinancialCycle
import com.yansuu1.jizhang.repo.FinancialCycleKind
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

private const val CONFIG_PATH = "$FINANCIAL_PLANNING_PATH/config"

/**
 * Server-backed financial execution configuration.
 *
 * - Loads `GET /config`; edits only the typed server fields, never legacy settings.
 * - Every PUT carries `operationId + expectedRevision` (CAS). The exact payload is
 *   persisted in [OperationReplayStore] before the request, scoped to the
 *   authenticated server/user, so an unknown result survives process restart.
 * - Success -> remove pending -> `onSaved()` -> `onClose()`; refresh failures are
 *   the host's concern and are never reported as a failed save here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FinancialConfigSheet(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onSaved: () -> Unit,
    onClose: () -> Unit,
) {
    val repo = remember(api) { FinancialExecutionRepository(api) }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }
    val scope = rememberCoroutineScope()
    val tokens = LocalWebTokens.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var response by remember { mutableStateOf<FinancialConfigResponse?>(null) }
    var draft by remember { mutableStateOf<FinancialConfigDraft?>(null) }
    var baseline by remember { mutableStateOf<FinancialConfigDraft?>(null) }
    var saving by remember { mutableStateOf(false) }
    var recoveryBusy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var conflict by remember { mutableStateOf(false) }
    var pendingOp by remember { mutableStateOf<PendingFinancialOperation?>(null) }
    var pendingScope by remember { mutableStateOf<FinancialScope?>(null) }
    var showDiscard by remember { mutableStateOf(false) }

    suspend fun clearPendingQuietly(scopeInfo: FinancialScope, operationId: String) {
        try {
            replayStore.remove(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, operationId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The server already committed; a leftovers record can only replay the same result.
        }
    }

    fun load() {
        scope.launch {
            loading = true
            loadError = null
            actionError = null
            pendingOp = null
            pendingScope = null
            notice = null
            try {
                val loaded = repo.getConfig()
                response = loaded
                val loadedDraft = FinancialConfigDraftLogic.from(loaded.config)
                draft = loadedDraft
                baseline = loadedDraft
                conflict = false
                // Re-surface a persisted unknown result for this exact authenticated scope.
                try {
                    val scopeInfo = FinancialPrefs.resolveAuthenticatedScope(api)
                    val persisted = replayStore.list(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity)
                        .filter { it.path == CONFIG_PATH }
                        .maxByOrNull { it.createdAt }
                    if (persisted != null) {
                        pendingOp = persisted
                        pendingScope = scopeInfo
                        notice = "发现上次未确认保存结果的配置操作，可查询服务端结果或重试原请求。"
                    }
                } catch (e: AuthExpiredException) {
                    throw e
                } catch (_: Exception) {
                    // Reading config succeeded; the write path resolves the scope again.
                }
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                loadError = e.message?.takeIf { it.isNotBlank() } ?: "财务配置加载失败，请重试。"
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(api) { load() }

    fun requestClose() {
        if (saving || recoveryBusy) return
        val current = draft
        val base = baseline
        if (current != null && base != null && FinancialConfigDraftLogic.isDirty(current, base)) {
            showDiscard = true
        } else {
            onClose()
        }
    }

    fun save() {
        if (saving || recoveryBusy) return
        val loaded = response ?: return
        val current = draft ?: return
        if (pendingOp != null) {
            actionError = "存在待恢复的保存操作，请先查询服务端结果或重试原请求。"
            return
        }
        if (conflict) {
            actionError = "配置已在其他设备更新，请先重新加载后再保存。"
            return
        }
        val parsed = FinancialConfigDraftLogic.validate(current).getOrElse { error ->
            actionError = error.message ?: "请检查配置输入"
            return
        }
        val operationId = UUID.randomUUID().toString()
        val request = FinancialConfigDraftLogic.buildUpdate(operationId, loaded.config.revision, parsed)
        val pending = financialPendingOperation(operationId, "PUT", CONFIG_PATH, request.toJson())

        scope.launch {
            saving = true
            actionError = null
            val scopeInfo = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: AuthExpiredException) {
                saving = false
                onAuthExpired()
                return@launch
            } catch (e: CancellationException) {
                saving = false
                throw e
            } catch (e: Exception) {
                saving = false
                actionError = "无法确认当前登录用户，已阻止保存：${e.message ?: "请重新登录"}"
                return@launch
            }
            try {
                replayStore.record(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, pending)
            } catch (e: CancellationException) {
                saving = false
                throw e
            } catch (e: Exception) {
                saving = false
                actionError = "无法持久化待执行操作，已阻止提交：${e.message ?: "本地存储失败"}"
                return@launch
            }
            try {
                repo.updateConfig(request)
                clearPendingQuietly(scopeInfo, operationId)
                pendingOp = null
                pendingScope = null
                saving = false
                try {
                    onSaved()
                } finally {
                    onClose()
                }
            } catch (e: AuthExpiredException) {
                clearPendingQuietly(scopeInfo, operationId)
                saving = false
                onAuthExpired()
            } catch (e: CancellationException) {
                saving = false
                throw e
            } catch (e: Exception) {
                saving = false
                when (val failure = classifyFinancialWriteFailure(e)) {
                    FinancialWriteFailure.AuthExpired -> onAuthExpired()
                    is FinancialWriteFailure.Rejected -> {
                        clearPendingQuietly(scopeInfo, operationId)
                        actionError = failure.message
                        if (failure.code == "FINANCIAL_REVISION_CONFLICT") conflict = true
                    }
                    is FinancialWriteFailure.Unknown -> {
                        pendingOp = pending
                        pendingScope = scopeInfo
                        actionError = "保存结果未知：${failure.message}。原请求已持久化，请显式查询或重试。"
                    }
                }
            }
        }
    }

    fun recoverResult() {
        val pending = pendingOp ?: return
        val storedScope = pendingScope ?: return
        if (saving || recoveryBusy) return
        scope.launch {
            recoveryBusy = true
            actionError = null
            val currentScope = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: AuthExpiredException) {
                recoveryBusy = false
                onAuthExpired()
                return@launch
            } catch (e: CancellationException) {
                recoveryBusy = false
                throw e
            } catch (e: Exception) {
                recoveryBusy = false
                actionError = "无法确认当前登录用户：${e.message ?: "请重新登录"}"
                return@launch
            }
            if (currentScope.serverBaseUrl != storedScope.serverBaseUrl ||
                currentScope.storageIdentity != storedScope.storageIdentity
            ) {
                recoveryBusy = false
                actionError = "登录用户或服务端已变化，无法恢复旧操作；请返回后重新进入。"
                return@launch
            }
            try {
                val operation = repo.getOperation(pending.operationId)
                if (operation.statusCode in 200..299) {
                    FinancialConfigUpdateResponse.fromJson(operation.response)
                    clearPendingQuietly(storedScope, pending.operationId)
                    pendingOp = null
                    pendingScope = null
                    recoveryBusy = false
                    try {
                        onSaved()
                    } finally {
                        onClose()
                    }
                } else {
                    clearPendingQuietly(storedScope, pending.operationId)
                    pendingOp = null
                    pendingScope = null
                    recoveryBusy = false
                    actionError = operation.response.optJSONObject("error")?.optString("message")
                        ?.takeIf { it.isNotBlank() }
                        ?: "服务端记录该操作失败（${operation.statusCode}），已清除本机待恢复记录。"
                }
            } catch (e: AuthExpiredException) {
                recoveryBusy = false
                onAuthExpired()
            } catch (e: ApiException) {
                recoveryBusy = false
                actionError = if (e.status == 404) {
                    "服务端没有该操作记录，请求可能尚未提交；可点击“重试原请求”安全重发。"
                } else {
                    "查询保存结果失败：${e.message ?: "请稍后重试"}。待恢复记录仍保留。"
                }
            } catch (e: CancellationException) {
                recoveryBusy = false
                throw e
            } catch (e: Exception) {
                recoveryBusy = false
                actionError = "无法读取服务端操作记录：${e.message ?: "响应格式异常"}；待恢复记录仍保留，可重试原请求。"
            }
        }
    }

    fun retryPending() {
        val pending = pendingOp ?: return
        val storedScope = pendingScope ?: return
        if (saving || recoveryBusy) return
        scope.launch {
            recoveryBusy = true
            actionError = null
            val currentScope = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: AuthExpiredException) {
                recoveryBusy = false
                onAuthExpired()
                return@launch
            } catch (e: CancellationException) {
                recoveryBusy = false
                throw e
            } catch (e: Exception) {
                recoveryBusy = false
                actionError = "无法确认当前登录用户：${e.message ?: "请重新登录"}"
                return@launch
            }
            if (currentScope.serverBaseUrl != storedScope.serverBaseUrl ||
                currentScope.storageIdentity != storedScope.storageIdentity
            ) {
                recoveryBusy = false
                actionError = "登录用户或服务端已变化，不能重放旧请求；请返回后重新进入。"
                return@launch
            }
            try {
                val payload = JSONObject(pending.payloadJson)
                val raw = repo.replayOperation(pending.method, pending.path, payload)
                FinancialConfigUpdateResponse.fromJson(raw)
                clearPendingQuietly(storedScope, pending.operationId)
                pendingOp = null
                pendingScope = null
                recoveryBusy = false
                try {
                    onSaved()
                } finally {
                    onClose()
                }
            } catch (e: AuthExpiredException) {
                recoveryBusy = false
                onAuthExpired()
            } catch (e: CancellationException) {
                recoveryBusy = false
                throw e
            } catch (e: Exception) {
                recoveryBusy = false
                when (val failure = classifyFinancialWriteFailure(e)) {
                    FinancialWriteFailure.AuthExpired -> onAuthExpired()
                    is FinancialWriteFailure.Rejected -> {
                        clearPendingQuietly(storedScope, pending.operationId)
                        pendingOp = null
                        pendingScope = null
                        actionError = "服务端拒绝了原请求：${failure.message}"
                        if (failure.code == "FINANCIAL_REVISION_CONFLICT") conflict = true
                    }
                    is FinancialWriteFailure.Unknown -> {
                        actionError = "重试结果仍未知：${failure.message}。原请求继续保留，可稍后再次查询。"
                    }
                }
            }
        }
    }

    val currentDraft = draft
    val currentBaseline = baseline
    val ratiosValid = currentDraft?.let {
        runCatching {
            listOf(
                FinancialSheetDecimal.parsePercentToBps(it.growthPercent, "成长比例"),
                FinancialSheetDecimal.parsePercentToBps(it.reservePercent, "储备比例"),
                FinancialSheetDecimal.parsePercentToBps(it.essentialsPercent, "必要开支比例"),
                FinancialSheetDecimal.parsePercentToBps(it.joyPercent, "随心消费比例"),
            ).sum()
        }.getOrNull()
    }
    val dirty = currentDraft != null && currentBaseline != null &&
        FinancialConfigDraftLogic.isDirty(currentDraft, currentBaseline)

    ModalBottomSheet(
        onDismissRequest = { requestClose() },
        sheetState = sheetState,
        containerColor = tokens.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "四用途执行配置",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = tokens.fg,
                    )
                    Text(
                        text = "仅影响之后确认的新周期，已冻结周期不会重新计算。",
                        style = MaterialTheme.typography.bodySmall,
                        color = tokens.muted,
                    )
                }
                response?.let {
                    Text(
                        text = "r${it.config.revision}",
                        fontSize = 12.sp,
                        color = tokens.muted,
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            when {
                loading && response == null -> {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 36.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator()
                            Spacer(Modifier.height(8.dp))
                            Text("正在加载财务配置…", style = MaterialTheme.typography.bodySmall, color = tokens.muted)
                        }
                    }
                }

                loadError != null && response == null -> {
                    Surface(
                        color = tokens.dangerSubtle,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(loadError.orEmpty(), color = tokens.danger, style = MaterialTheme.typography.bodyMedium)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(
                                    onClick = { load() },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text("重试") }
                                TextButton(
                                    onClick = { onClose() },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text("关闭") }
                            }
                        }
                    }
                }

                currentDraft != null -> {
                    notice?.let {
                        Surface(
                            color = tokens.warning.copy(alpha = 0.10f),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = it,
                                modifier = Modifier.padding(12.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.warning,
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                    }

                    pendingOp?.let { pending ->
                        PendingConfigRecoveryCard(
                            pending = pending,
                            busy = recoveryBusy,
                            onQuery = { recoverResult() },
                            onRetry = { retryPending() },
                        )
                        Spacer(Modifier.height(12.dp))
                    }

                    actionError?.let {
                        Surface(
                            color = tokens.dangerSubtle,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(12.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.Top,
                            ) {
                                Icon(Icons.Filled.Warning, contentDescription = null, tint = tokens.danger)
                                Text(it, color = tokens.danger, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                    }

                    if (conflict) {
                        Surface(
                            color = tokens.warning.copy(alpha = 0.12f),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    "配置已被其他设备修改，需重新加载后端版本后才能保存。",
                                    modifier = Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = tokens.warning,
                                )
                                OutlinedButton(
                                    onClick = { load() },
                                    enabled = !saving && !recoveryBusy,
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text("重新加载") }
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                    }

                    ConfigSwitchRow(
                        enabled = currentDraft.enabled,
                        saving = saving || recoveryBusy,
                        onEnabledChange = { checked -> draft = currentDraft.copy(enabled = checked) },
                    )

                    HorizontalDivider(Modifier.padding(vertical = 14.dp))

                    ConfigSectionTitle(
                        title = "四用途比例",
                        subtitle = "使用百分比，最多两位小数；四项必须正好合计 100%。",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                        RatioField(
                            label = "成长 %",
                            value = currentDraft.growthPercent,
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.weight(1f),
                            onValueChange = { value -> draft = currentDraft.copy(growthPercent = value) },
                        )
                        RatioField(
                            label = "储备 %",
                            value = currentDraft.reservePercent,
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.weight(1f),
                            onValueChange = { value -> draft = currentDraft.copy(reservePercent = value) },
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                        RatioField(
                            label = "必要开支 %",
                            value = currentDraft.essentialsPercent,
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.weight(1f),
                            onValueChange = { value -> draft = currentDraft.copy(essentialsPercent = value) },
                        )
                        RatioField(
                            label = "随心消费 %",
                            value = currentDraft.joyPercent,
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.weight(1f),
                            onValueChange = { value -> draft = currentDraft.copy(joyPercent = value) },
                        )
                    }
                    Text(
                        text = when (ratiosValid) {
                            10000 -> "合计 100.00%（10000 bps）"
                            null -> "请输入四项有效比例"
                            else -> "合计 ${FinancialSheetDecimal.formatPercent(ratiosValid)}%，必须正好 100%"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (ratiosValid == 10000) tokens.ok else tokens.warning,
                        modifier = Modifier.padding(top = 6.dp),
                    )

                    HorizontalDivider(Modifier.padding(vertical = 14.dp))

                    ConfigSectionTitle(
                        title = "支出与储备参数",
                        subtitle = "必要开支留空表示“未设置”，不会被当作 0。",
                    )
                    OutlinedTextField(
                        value = currentDraft.essentialYuan,
                        onValueChange = { value -> draft = currentDraft.copy(essentialYuan = value) },
                        label = { Text("每月必要开支（元，可留空）") },
                        supportingText = { Text("用于目标月数测算；留空与 0 不同，由服务端按未设置处理。") },
                        enabled = !saving && !recoveryBusy,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = currentDraft.targetMonths,
                        onValueChange = { value -> draft = currentDraft.copy(targetMonths = value) },
                        label = { Text("目标月数（1–120）") },
                        enabled = !saving && !recoveryBusy,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )

                    HorizontalDivider(Modifier.padding(vertical = 14.dp))

                    ConfigSectionTitle(
                        title = "收入周期",
                        subtitle = "只影响未来新周期；已确认周期保持冻结的日期与分配。",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        FilterChip(
                            selected = currentDraft.cycleKind == FinancialCycleKind.NATURAL_MONTH,
                            onClick = {
                                if (!saving && !recoveryBusy) {
                                    draft = currentDraft.copy(cycleKind = FinancialCycleKind.NATURAL_MONTH)
                                }
                            },
                            label = { Text("自然月") },
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                        FilterChip(
                            selected = currentDraft.cycleKind == FinancialCycleKind.START_DAY,
                            onClick = {
                                if (!saving && !recoveryBusy) {
                                    draft = currentDraft.copy(cycleKind = FinancialCycleKind.START_DAY)
                                }
                            },
                            label = { Text("每月固定起始日") },
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                    if (currentDraft.cycleKind == FinancialCycleKind.START_DAY) {
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = currentDraft.cycleDay,
                            onValueChange = { value -> draft = currentDraft.copy(cycleDay = value) },
                            label = { Text("起始日（1–28）") },
                            supportingText = { Text("例如 25 表示每月 25 日开始的工资周期。") },
                            enabled = !saving && !recoveryBusy,
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = currentDraft.timeZone,
                        onValueChange = { value -> draft = currentDraft.copy(timeZone = value) },
                        label = { Text("IANA 时区") },
                        supportingText = { Text("例如 Asia/Shanghai；时区合法性由服务端校验。") },
                        enabled = !saving && !recoveryBusy,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                        modifier = Modifier.fillMaxWidth(),
                    )

                    response?.config?.updatedAt?.let { updatedAt ->
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = "上次保存：${formatDay(updatedAt)} · 映射版本 r${response?.mappingRevision ?: 0}",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.muted,
                        )
                    }
                    response?.legacyCycle?.let { legacy ->
                        Text(
                            text = "旧手动规划周期：${cycleLabel(legacy)}（仅参考，不随本设置改写）",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.muted,
                        )
                    }

                    Spacer(Modifier.height(20.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        OutlinedButton(
                            onClick = { requestClose() },
                            enabled = !saving && !recoveryBusy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text("取消") }
                        Button(
                            onClick = { save() },
                            enabled = !saving && !recoveryBusy && dirty && !conflict && pendingOp == null,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) {
                            if (saving) {
                                CircularProgressIndicator(
                                    modifier = Modifier.width(18.dp).height(18.dp),
                                    strokeWidth = 2.dp,
                                    color = tokens.onAccent,
                                )
                                Spacer(Modifier.width(6.dp))
                                Text("保存中…")
                            } else {
                                Text(if (dirty) "保存配置" else "无修改")
                            }
                        }
                    }
                }
            }
        }
    }

    if (showDiscard) {
        AlertDialog(
            onDismissRequest = { showDiscard = false },
            title = { Text("放弃未保存的修改？") },
            text = { Text("当前配置尚未保存。关闭后本次修改会丢弃，已确认周期的冻结配置不受影响。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDiscard = false
                        onClose()
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("放弃修改") }
            },
            dismissButton = {
                TextButton(
                    onClick = { showDiscard = false },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("继续编辑") }
            },
        )
    }
}

@Composable
private fun ConfigSwitchRow(
    enabled: Boolean,
    saving: Boolean,
    onEnabledChange: (Boolean) -> Unit,
) {
    val tokens = LocalWebTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("启用四用途执行", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = tokens.fg)
            Text(
                "关闭后阻止新周期确认与重算，但读取和账单用途仍可用。",
                style = MaterialTheme.typography.bodySmall,
                color = tokens.muted,
            )
        }
        Switch(checked = enabled, onCheckedChange = onEnabledChange, enabled = !saving)
    }
}

@Composable
private fun ConfigSectionTitle(title: String, subtitle: String) {
    val tokens = LocalWebTokens.current
    Column(Modifier.padding(bottom = 8.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = tokens.fg)
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = tokens.muted)
    }
}

@Composable
private fun RatioField(
    label: String,
    value: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = modifier.heightIn(min = 56.dp),
    )
}

@Composable
private fun PendingConfigRecoveryCard(
    pending: PendingFinancialOperation,
    busy: Boolean,
    onQuery: () -> Unit,
    onRetry: () -> Unit,
) {
    val tokens = LocalWebTokens.current
    Surface(
        color = tokens.warning.copy(alpha = 0.10f),
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "待恢复的配置保存",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = tokens.warning,
            )
            Text(
                "操作 ${pending.operationId.take(8)}… 已在发送前保存。查询服务端结果，或重发完全相同的原请求。",
                style = MaterialTheme.typography.bodySmall,
                color = tokens.warning,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = onQuery,
                    enabled = !busy,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    if (busy) {
                        CircularProgressIndicator(modifier = Modifier.width(16.dp).height(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text("查询结果")
                }
                Button(
                    onClick = onRetry,
                    enabled = !busy,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("重试原请求") }
            }
        }
    }
}

private fun cycleLabel(cycle: FinancialCycle): String = when (cycle.kind) {
    FinancialCycleKind.NATURAL_MONTH -> "自然月"
    FinancialCycleKind.START_DAY -> "每月 ${cycle.day ?: 1} 日"
}
