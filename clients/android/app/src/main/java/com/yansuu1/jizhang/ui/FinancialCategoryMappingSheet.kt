package com.yansuu1.jizhang.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
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
import com.yansuu1.jizhang.repo.AdminRepository
import com.yansuu1.jizhang.repo.FinancialCategoryRulesResponse
import com.yansuu1.jizhang.repo.FinancialCategoryRulesUpdateRequest
import com.yansuu1.jizhang.repo.FinancialConfigResponse
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.SpendingPurpose
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

private const val CATEGORY_RULES_PATH = "$FINANCIAL_PLANNING_PATH/category-rules"

/**
 * Full-replacement category -> spending-purpose mapping.
 *
 * The four UI states are intentionally distinct:
 * - 跟随分类: emit NO rule (absence of an entry means inherit).
 * - 必要 / 随心: emit an explicit purpose rule.
 * - 待归类: emit `purpose = null`, which stops ancestor inheritance.
 *
 * The whole mapping snapshot is edited offline and PUT with both `expectedRevision`
 * (CAS) and `expectedTopologyToken` (category tree CAS). Labels come from the
 * existing categories endpoint with `includeDeleted=true`; labels are display-only
 * and never drive the mapping.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun FinancialCategoryMappingSheet(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onSaved: () -> Unit,
    onClose: () -> Unit,
) {
    val repo = remember(api) { FinancialExecutionRepository(api) }
    val admin = remember(api) { AdminRepository(api) }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }
    val scope = rememberCoroutineScope()
    val tokens = LocalWebTokens.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var labelWarning by remember { mutableStateOf<String?>(null) }
    var diagnosticsExpanded by remember { mutableStateOf(false) }
    var diagnosticsLoading by remember { mutableStateOf(false) }
    var diagnosticsError by remember { mutableStateOf<String?>(null) }
    var configDiagnostics by remember { mutableStateOf<FinancialConfigResponse?>(null) }
    var response by remember { mutableStateOf<FinancialCategoryRulesResponse?>(null) }
    var labels by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var rows by remember { mutableStateOf<List<FinancialMappingRow>>(emptyList()) }
    var baseline by remember { mutableStateOf<Map<String, FinancialRuleChoice>>(emptyMap()) }
    var draftChoices by remember { mutableStateOf<Map<String, FinancialRuleChoice>>(emptyMap()) }
    var search by remember { mutableStateOf("") }
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
            // Committed already; a leftover can only replay the same stored response.
        }
    }

    fun rebuildRows(mapping: FinancialCategoryRulesResponse, loadedLabels: Map<String, String>) {
        rows = FinancialMappingDraftLogic.buildRows(
            categories = mapping.mapping.categories,
            labels = loadedLabels,
            rules = mapping.mapping.rules,
        )
    }

    fun load() {
        scope.launch {
            loading = true
            loadError = null
            labelWarning = null
            actionError = null
            pendingOp = null
            pendingScope = null
            notice = null
            try {
                val loaded = repo.getCategoryRules()
                response = loaded
                val loadedChoices = FinancialMappingDraftLogic.choicesOf(loaded.mapping.rules)
                baseline = loadedChoices
                draftChoices = loadedChoices
                conflict = false
                var loadedLabels: Map<String, String> = emptyMap()
                try {
                    val items = admin.categories(type = 0, includeDeleted = true).optJSONArray("items")
                    loadedLabels = buildMap {
                        if (items != null) {
                            for (index in 0 until items.length()) {
                                val item = items.optJSONObject(index) ?: continue
                                val id = item.optString("id")
                                val name = item.optString("name")
                                if (id.isNotBlank() && name.isNotBlank()) put(id, name)
                            }
                        }
                    }
                } catch (e: AuthExpiredException) {
                    throw e
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    labelWarning = "分类名称加载失败，将显示分类编号；映射数据不受影响。"
                }
                labels = loadedLabels
                rebuildRows(loaded, loadedLabels)
                try {
                    val scopeInfo = FinancialPrefs.resolveAuthenticatedScope(api)
                    val persisted = replayStore.list(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity)
                        .filter { it.path == CATEGORY_RULES_PATH }
                        .maxByOrNull { it.createdAt }
                    if (persisted != null) {
                        pendingOp = persisted
                        pendingScope = scopeInfo
                        notice = "发现上次未确认保存结果的映射操作，可查询服务端结果或重试原请求。"
                    }
                } catch (e: AuthExpiredException) {
                    throw e
                } catch (_: Exception) {
                    // Mapping read succeeded; writes resolve the authenticated scope again.
                }
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                loadError = e.message?.takeIf { it.isNotBlank() } ?: "分类映射加载失败，请重试。"
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(api) { load() }

    fun loadDiagnostics() {
        if (configDiagnostics != null || diagnosticsLoading) return
        scope.launch {
            diagnosticsLoading = true
            diagnosticsError = null
            try {
                configDiagnostics = repo.getConfig()
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                diagnosticsError = e.message?.takeIf { it.isNotBlank() } ?: "比例基点诊断暂不可用。"
            } finally {
                diagnosticsLoading = false
            }
        }
    }

    fun toggleDiagnostics() {
        diagnosticsExpanded = !diagnosticsExpanded
        if (diagnosticsExpanded) loadDiagnostics()
    }

    val dirty = draftChoices != baseline
    val explicitCount = draftChoices.count { it.value != FinancialRuleChoice.INHERIT }
    val parentById = remember(response) {
        response?.mapping?.categories?.associate { it.id to it.parentId }.orEmpty()
    }
    val labelById = remember(rows) { rows.associate { it.categoryId to it.label } }
    val filteredRows = remember(rows, search) {
        val query = search.trim()
        if (query.isEmpty()) {
            rows
        } else {
            rows.filter { it.label.contains(query, ignoreCase = true) || it.categoryId.contains(query, ignoreCase = true) }
        }
    }

    fun requestClose() {
        if (saving || recoveryBusy) return
        if (dirty) showDiscard = true else onClose()
    }

    fun save() {
        if (saving || recoveryBusy) return
        val loaded = response ?: return
        if (pendingOp != null) {
            actionError = "存在待恢复的保存操作，请先查询服务端结果或重试原请求。"
            return
        }
        if (conflict) {
            actionError = "分类树或映射已在其他设备更新，请先重新加载。"
            return
        }
        val allowed = loaded.mapping.categories.map { it.id }.toSet()
        val rules = FinancialMappingDraftLogic.validate(draftChoices, allowed).getOrElse { error ->
            actionError = error.message ?: "请检查分类规则"
            return
        }
        val operationId = UUID.randomUUID().toString()
        val request = FinancialCategoryRulesUpdateRequest(
            operationId = operationId,
            expectedRevision = loaded.mapping.revision,
            expectedTopologyToken = loaded.mapping.topologyToken,
            rules = rules,
        )
        val pending = financialPendingOperation(operationId, "PUT", CATEGORY_RULES_PATH, request.toJson())

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
                val updated = repo.updateCategoryRules(request)
                clearPendingQuietly(scopeInfo, operationId)
                response = updated
                val updatedChoices = FinancialMappingDraftLogic.choicesOf(updated.mapping.rules)
                baseline = updatedChoices
                draftChoices = updatedChoices
                rebuildRows(updated, labels)
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
                    val updated = FinancialCategoryRulesResponse.fromJson(operation.response)
                    clearPendingQuietly(storedScope, pending.operationId)
                    response = updated
                    val updatedChoices = FinancialMappingDraftLogic.choicesOf(updated.mapping.rules)
                    baseline = updatedChoices
                    draftChoices = updatedChoices
                    rebuildRows(updated, labels)
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
                val updated = FinancialCategoryRulesResponse.fromJson(raw)
                clearPendingQuietly(storedScope, pending.operationId)
                response = updated
                val updatedChoices = FinancialMappingDraftLogic.choicesOf(updated.mapping.rules)
                baseline = updatedChoices
                draftChoices = updatedChoices
                rebuildRows(updated, labels)
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

    ModalBottomSheet(
        onDismissRequest = { requestClose() },
        sheetState = sheetState,
        containerColor = tokens.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f)
                .imePadding()
                .padding(horizontal = 20.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "分类用途映射",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = tokens.fg,
                    )
                    Text(
                        text = "整份替换：保存后本页所有分类规则成为新快照，已冻结周期不受影响。",
                        style = MaterialTheme.typography.bodySmall,
                        color = tokens.muted,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            when {
                loading && response == null -> {
                    Box(
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator()
                            Spacer(Modifier.height(8.dp))
                            Text("正在加载分类映射…", style = MaterialTheme.typography.bodySmall, color = tokens.muted)
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

                response != null -> {
                    Surface(
                        color = tokens.accentSubtle,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                "跟随分类 = 不写规则，沿父级规则生效；待归类 = 写入空用途，阻止父级继承。",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.accent,
                            )
                            Text(
                                "已设置 $explicitCount 条 / 上限 2000；父级分类的规则会被子分类继承，除非子分类明确设置。",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.muted,
                            )
                        }
                    }
                    TextButton(
                        onClick = ::toggleDiagnostics,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (diagnosticsExpanded) "收起诊断详情" else "诊断详情") }
                    if (diagnosticsExpanded) {
                        Surface(
                            color = tokens.surfaceSoft,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("映射修订：r${response?.mapping?.revision ?: "—"}", style = MaterialTheme.typography.bodySmall)
                                Text("分类树拓扑令牌：${response?.mapping?.topologyToken.orEmpty()}", style = MaterialTheme.typography.bodySmall)
                                when {
                                    diagnosticsLoading -> Text("正在读取比例基点…", style = MaterialTheme.typography.bodySmall, color = tokens.muted)
                                    configDiagnostics != null -> {
                                        val currentConfig = configDiagnostics!!
                                        val ratios = currentConfig.config.ratiosBps
                                        Text("配置修订：r${currentConfig.config.revision} · 配置映射修订：r${currentConfig.mappingRevision}", style = MaterialTheme.typography.bodySmall)
                                        Text(
                                            "当前配置比例（bps）：成长 ${ratios.growth} / 应急 ${ratios.reserve} / 必要 ${ratios.essentials} / 随心 ${ratios.joy}（合计 10000）",
                                            style = MaterialTheme.typography.bodySmall,
                                        )
                                    }
                                    diagnosticsError != null -> Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        Text(diagnosticsError.orEmpty(), modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = tokens.warning)
                                        TextButton(onClick = ::loadDiagnostics, enabled = !diagnosticsLoading) { Text("重试") }
                                    }
                                    else -> Text("比例基点暂不可用。", style = MaterialTheme.typography.bodySmall, color = tokens.muted)
                                }
                            }
                        }
                    }
                    labelWarning?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = tokens.warning)
                    }
                    notice?.let {
                        Spacer(Modifier.height(6.dp))
                        Surface(
                            color = tokens.warning.copy(alpha = 0.10f),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                it,
                                modifier = Modifier.padding(10.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.warning,
                            )
                        }
                    }
                    pendingOp?.let { pending ->
                        Spacer(Modifier.height(8.dp))
                        PendingMappingRecoveryCard(
                            pending = pending,
                            busy = recoveryBusy,
                            onQuery = { recoverResult() },
                            onRetry = { retryPending() },
                        )
                    }
                    actionError?.let {
                        Spacer(Modifier.height(8.dp))
                        Surface(
                            color = tokens.dangerSubtle,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(10.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.Top,
                            ) {
                                Icon(Icons.Filled.Warning, contentDescription = null, tint = tokens.danger)
                                Text(it, color = tokens.danger, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    if (conflict) {
                        Spacer(Modifier.height(8.dp))
                        Surface(
                            color = tokens.warning.copy(alpha = 0.12f),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    "分类树或映射已被其他设备修改，请重新加载后再保存。",
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
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = search,
                        onValueChange = { search = it },
                        label = { Text("搜索分类名称或编号") },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        singleLine = true,
                        enabled = !saving && !recoveryBusy,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(6.dp))
                    HorizontalDivider()
                    LazyColumn(
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(filteredRows, key = { it.categoryId }) { row ->
                            MappingRuleRow(
                                row = row,
                                choice = draftChoices[row.categoryId] ?: FinancialRuleChoice.INHERIT,
                                effective = FinancialMappingDraftLogic.effectivePurpose(
                                    categoryId = row.categoryId,
                                    choices = draftChoices,
                                    parentById = parentById,
                                ),
                                rowLabelById = labelById,
                                enabled = !saving && !recoveryBusy,
                                onChoice = { choice ->
                                    draftChoices = if (choice == FinancialRuleChoice.INHERIT) {
                                        draftChoices - row.categoryId
                                    } else {
                                        draftChoices + (row.categoryId to choice)
                                    }
                                },
                            )
                        }
                        if (filteredRows.isEmpty()) {
                            item {
                                Text(
                                    "没有匹配的分类。",
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = tokens.muted,
                                )
                            }
                        }
                        item { Spacer(Modifier.height(8.dp)) }
                    }
                    HorizontalDivider()
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
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
                                Text(if (dirty) "保存映射" else "无修改")
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
            title = { Text("放弃未保存的映射修改？") },
            text = { Text("当前映射修改尚未保存。关闭后本次修改会丢弃，已确认周期的冻结映射不受影响。") },
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MappingRuleRow(
    row: FinancialMappingRow,
    choice: FinancialRuleChoice,
    effective: FinancialInheritedPurpose,
    rowLabelById: Map<String, String>,
    enabled: Boolean,
    onChoice: (FinancialRuleChoice) -> Unit,
) {
    val tokens = LocalWebTokens.current
    Surface(
        color = if (row.deleted) tokens.surfaceSoft else tokens.surface,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, tokens.border.copy(alpha = 0.7f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(start = (10 + row.depth * 12).dp, end = 10.dp, top = 8.dp, bottom = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = row.label,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (row.depth == 0) FontWeight.SemiBold else FontWeight.Normal,
                    color = tokens.fg,
                )
                if (row.deleted) {
                    Text(
                        "已删除·历史规则",
                        fontSize = 10.sp,
                        color = tokens.warning,
                    )
                }
            }
            if (row.depth > 0 || row.deleted) {
                Text(
                    text = if (row.deleted) "此分类已删除，仅保留/移除历史规则" else "子分类",
                    style = MaterialTheme.typography.labelSmall,
                    color = tokens.muted,
                )
            }
            Text(
                text = when {
                    choice == FinancialRuleChoice.EXPLICIT_UNRESOLVED -> "待归类：阻止继承上级规则"
                    effective.stoppedByExplicitUnresolved -> "继承结果：上级设为待归类，当前保持待归类"
                    effective.purpose == SpendingPurpose.ESSENTIALS -> {
                        val source = effective.sourceCategoryId?.let { rowLabelById[it] ?: "上级分类" }
                        if (effective.sourceCategoryId == row.categoryId) "当前生效：必要（本分类明确规则）"
                        else "当前生效：必要（跟随 $source）"
                    }
                    effective.purpose == SpendingPurpose.JOY -> {
                        val source = effective.sourceCategoryId?.let { rowLabelById[it] ?: "上级分类" }
                        if (effective.sourceCategoryId == row.categoryId) "当前生效：随心（本分类明确规则）"
                        else "当前生效：随心（跟随 $source）"
                    }
                    else -> "待归类（不会计入任何用途）"
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (effective.purpose == null) tokens.muted else tokens.accent,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                RuleChip("跟随分类", choice == FinancialRuleChoice.INHERIT, enabled) {
                    onChoice(FinancialRuleChoice.INHERIT)
                }
                RuleChip("必要", choice == FinancialRuleChoice.ESSENTIALS, enabled) {
                    onChoice(FinancialRuleChoice.ESSENTIALS)
                }
                RuleChip("随心", choice == FinancialRuleChoice.JOY, enabled) {
                    onChoice(FinancialRuleChoice.JOY)
                }
                RuleChip("待归类", choice == FinancialRuleChoice.EXPLICIT_UNRESOLVED, enabled) {
                    onChoice(FinancialRuleChoice.EXPLICIT_UNRESOLVED)
                }
            }
        }
    }
}

@Composable
private fun RuleChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, fontSize = 11.sp) },
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
    )
}

@Composable
private fun PendingMappingRecoveryCard(
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
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "待恢复的映射保存",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = tokens.warning,
            )
            Text(
                "操作 ${pending.operationId.take(8)}… 已在发送前保存。可查询服务端结果或重发完全相同的原请求。",
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
