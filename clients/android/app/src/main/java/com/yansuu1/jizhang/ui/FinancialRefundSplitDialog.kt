package com.yansuu1.jizhang.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.FinancialRefundOriginalState
import com.yansuu1.jizhang.repo.FinancialRefundReview
import com.yansuu1.jizhang.repo.FinancialRefundState
import com.yansuu1.jizhang.repo.FinancialRefundSplitsUpdateResponse
import com.yansuu1.jizhang.repo.LedgerRepository
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID
import kotlin.math.min

private fun refundSplitsPath(refundTransactionId: String): String =
    "$FINANCIAL_PLANNING_PATH/refunds/${financialPathSegment(refundTransactionId)}/splits"

/**
 * Explicit refund attribution. A bill save has already happened before this dialog
 * opens, so a split failure NEVER claims the bill was rolled back.
 *
 * Originals come from the server review (which includes more than legacy links) and
 * additionally from the existing expense picker. For picked originals the exact
 * `transactionToken` is fetched from the FP bill-purpose endpoint. Splits are exact
 * cents; partial allocation stays explicitly pending. The PUT is persisted first and
 * replayed exactly after an unknown result.
 */
@Composable
fun FinancialRefundSplitDialog(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onSaved: () -> Unit,
    onClose: () -> Unit,
    refundTransactionId: String,
) {
    val repo = remember(api) { FinancialExecutionRepository(api) }
    val ledger = remember(api) { LedgerRepository(api) }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }
    val scope = rememberCoroutineScope()
    val tokens = LocalWebTokens.current
    val path = remember(refundTransactionId) { refundSplitsPath(refundTransactionId) }

    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var review by remember { mutableStateOf<FinancialRefundReview?>(null) }
    var baseline by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var draft by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var externalCandidates by remember { mutableStateOf<Map<String, FinancialRefundCandidate>>(emptyMap()) }
    var addingOriginals by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var recoveryBusy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var conflict by remember { mutableStateOf(false) }
    var pendingOp by remember { mutableStateOf<PendingFinancialOperation?>(null) }
    var pendingScope by remember { mutableStateOf<FinancialScope?>(null) }
    var showDiscard by remember { mutableStateOf(false) }
    var showReloadConfirm by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }

    suspend fun clearPendingQuietly(scopeInfo: FinancialScope, operationId: String) {
        try {
            replayStore.remove(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, operationId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Committed already; leftover replay returns the same stored response.
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
                val loaded = repo.getRefund(refundTransactionId)
                review = loaded.refund
                val loadedDraft = FinancialRefundDraftLogic.initialDraft(loaded.refund)
                baseline = loadedDraft
                draft = loadedDraft
                externalCandidates = emptyMap()
                conflict = false
                try {
                    val scopeInfo = FinancialPrefs.resolveAuthenticatedScope(api)
                    val persisted = replayStore.list(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity)
                        .filter { it.path == path }
                        .maxByOrNull { it.createdAt }
                    if (persisted != null) {
                        pendingOp = persisted
                        pendingScope = scopeInfo
                        notice = "发现上次未确认保存结果的退款分摊操作，可查询服务端结果或重试原请求。"
                    }
                } catch (e: AuthExpiredException) {
                    throw e
                } catch (_: Exception) {
                    // Review read succeeded; writes resolve the authenticated scope again.
                }
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                loadError = e.message?.takeIf { it.isNotBlank() } ?: "退款复核加载失败，请重试。"
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(api, refundTransactionId) { load() }

    val dirty = draft != baseline
    val candidates = remember(review, externalCandidates) {
        val base = review?.let { FinancialRefundDraftLogic.candidates(it) }.orEmpty()
        (base + externalCandidates.values).associateBy { it.originalId }
    }
    val currentTotal = remember(draft, review, externalCandidates) {
        val loaded = review
        if (loaded == null) {
            null
        } else {
            runCatching {
                FinancialRefundDraftLogic.validate(draft, loaded, externalCandidates).getOrThrow().totalCents
            }.getOrNull()
        }
    }
    val pendingCents = review?.let { loaded ->
        currentTotal?.let { (loaded.amountCents - it).coerceAtLeast(0) }
    }

    fun requestClose() {
        if (saving || recoveryBusy || addingOriginals) return
        if (dirty) showDiscard = true else onClose()
    }

    fun addOriginals(ids: Set<String>) {
        if (ids.isEmpty() || saving || addingOriginals) return
        scope.launch {
            addingOriginals = true
            actionError = null
            try {
                for (id in ids) {
                    if (externalCandidates.containsKey(id)) continue
                    if (review?.let { loaded ->
                            FinancialRefundDraftLogic.candidates(loaded).any { it.originalId == id }
                        } == true
                    ) {
                        continue
                    }
                    val tx = ledger.getTransaction(id)
                    val type = tx.optInt("type", -1)
                    val isRefund = tx.optBoolean("isRefund", false)
                    require(type == 0) { "只能将普通支出账单作为退款原单" }
                    require(!isRefund) { "退款账单不能作为另一个退款的原单" }
                    val amountCents = tx.optLong("amountCents", -1L)
                    val date = tx.optLong("date", 0L)
                    require(amountCents > 0) { "原单金额无效" }
                    val purpose = repo.getBillPurpose(id).billPurpose
                    require(purpose.transactionToken.isNotBlank()) { "原单用途令牌为空，无法分摊" }
                    val candidate = FinancialRefundCandidate(
                        originalId = id,
                        token = purpose.transactionToken,
                        amountCents = amountCents,
                        // Server validates other confirmed refunds; UI shows the gross cap.
                        remainingCents = amountCents,
                        date = date,
                        state = FinancialRefundOriginalState.LIVE,
                        otherConfirmedRefundCents = 0L,
                        isExternal = true,
                    )
                    externalCandidates = externalCandidates + (id to candidate)
                    val loadedReview = review ?: continue
                    val alreadyAllocated = runCatching {
                        FinancialRefundDraftLogic.validate(draft, loadedReview, externalCandidates)
                            .getOrThrow().totalCents
                    }.getOrDefault(0L)
                    val available = (loadedReview.amountCents - alreadyAllocated).coerceAtLeast(0L)
                    val defaultCents = min(candidate.remainingCents, available)
                    if (defaultCents > 0L) {
                        draft = draft + (id to FinancialPlanMoneyParser.formatCentsToYuan(defaultCents))
                    }
                }
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = "添加原单失败：${e.message ?: "请重试"}"
            } finally {
                addingOriginals = false
            }
        }
    }

    fun save(forceClear: Boolean = false) {
        if (saving || recoveryBusy || addingOriginals) return
        val loaded = review ?: return
        if (pendingOp != null) {
            actionError = "存在待恢复的保存操作，请先查询服务端结果或重试原请求。"
            return
        }
        if (loaded.state == FinancialRefundState.DELETED ||
            loaded.state == FinancialRefundState.PURGED ||
            loaded.state == FinancialRefundState.NOT_REFUND
        ) {
            actionError = "当前退款状态不可编辑分摊。"
            return
        }
        if (conflict) {
            actionError = "退款复核已变化，请先重新加载后再保存。"
            return
        }
        val validated = FinancialRefundDraftLogic.validate(draft, loaded, externalCandidates).getOrElse { error ->
            actionError = error.message ?: "请检查退款分摊"
            return
        }
        if (validated.splits.isEmpty() && loaded.splits.isNotEmpty() && !forceClear) {
            confirmClear = true
            return
        }
        val operationId = UUID.randomUUID().toString()
        val request = FinancialRefundDraftLogic.buildRequest(operationId, loaded, validated)
        val pending = financialPendingOperation(operationId, "PUT", path, request.toJson())

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
                val response = repo.updateRefundSplits(refundTransactionId, request)
                clearPendingQuietly(scopeInfo, operationId)
                review = response.refund
                val updatedDraft = FinancialRefundDraftLogic.initialDraft(response.refund)
                baseline = updatedDraft
                draft = updatedDraft
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
                        actionError = "${failure.message}（账单本身已保存，此失败不影响账单，也不会回滚账单。）"
                        if (failure.code == "FINANCIAL_REVISION_CONFLICT" ||
                            failure.code == "FINANCIAL_REFUND_CONFLICT" ||
                            failure.code == "FINANCIAL_SOURCE_CHANGED"
                        ) {
                            conflict = true
                        }
                    }
                    is FinancialWriteFailure.Unknown -> {
                        pendingOp = pending
                        pendingScope = scopeInfo
                        actionError = "分摊保存结果未知：${failure.message}。原请求已持久化；账单已保存，分摊失败不会回滚账单。"
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
                    val response = FinancialRefundSplitsUpdateResponse.fromJson(operation.response)
                    clearPendingQuietly(storedScope, pending.operationId)
                    review = response.refund
                    val updatedDraft = FinancialRefundDraftLogic.initialDraft(response.refund)
                    baseline = updatedDraft
                    draft = updatedDraft
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
                        ?: "服务端记录该分摊操作失败（${operation.statusCode}），已清除本机待恢复记录；账单仍保持已保存。"
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
                val response = FinancialRefundSplitsUpdateResponse.fromJson(raw)
                clearPendingQuietly(storedScope, pending.operationId)
                review = response.refund
                val updatedDraft = FinancialRefundDraftLogic.initialDraft(response.refund)
                baseline = updatedDraft
                draft = updatedDraft
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
                        actionError = "服务端拒绝了原请求：${failure.message}（账单本身已保存，不会回滚。）"
                        if (failure.code == "FINANCIAL_REVISION_CONFLICT" ||
                            failure.code == "FINANCIAL_REFUND_CONFLICT" ||
                            failure.code == "FINANCIAL_SOURCE_CHANGED"
                        ) {
                            conflict = true
                        }
                    }
                    is FinancialWriteFailure.Unknown -> {
                        actionError = "重试结果仍未知：${failure.message}。原请求继续保留，可稍后再次查询；账单不受影响。"
                    }
                }
            }
        }
    }

    Dialog(
        onDismissRequest = { requestClose() },
        properties = DialogProperties(
            dismissOnBackPress = true,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
        ),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f)
                .padding(horizontal = 12.dp, vertical = 16.dp),
            shape = RoundedCornerShape(20.dp),
            color = tokens.surface,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .padding(horizontal = 16.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = "退款分摊确认",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = tokens.fg,
                        )
                        Text(
                            text = "账单已保存；本步骤只确认退款归属，分摊失败不会回滚账单。",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.muted,
                        )
                    }
                    review?.let {
                        Text("¥${formatYuan(it.amountCents)}", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = tokens.fg)
                    }
                }

                Spacer(Modifier.height(8.dp))

                when {
                    loading && review == null -> {
                        Box(
                            modifier = Modifier.fillMaxWidth().weight(1f),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator()
                                Spacer(Modifier.height(8.dp))
                                Text("正在加载退款复核…", style = MaterialTheme.typography.bodySmall, color = tokens.muted)
                            }
                        }
                    }

                    loadError != null && review == null -> {
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

                    review != null -> {
                        val loaded = review!!
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text(
                                "退款日期：${formatDay(loaded.date)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.muted,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                "有效已归属 ¥${formatYuan(loaded.validAttributedCents)} · 未归属 ¥${formatYuan(loaded.unresolvedCents)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.muted,
                            )
                        }
                        if (loaded.reasons.isNotEmpty()) {
                            Text(
                                "状态：${refundStateLabel(loaded)} · ${loaded.reasons.joinToString("、")}",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.warning,
                            )
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
                            Spacer(Modifier.height(6.dp))
                            PendingRefundRecoveryCard(
                                pending = pending,
                                busy = recoveryBusy,
                                onQuery = { recoverResult() },
                                onRetry = { retryPending() },
                            )
                        }
                        actionError?.let {
                            Spacer(Modifier.height(6.dp))
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
                            Spacer(Modifier.height(6.dp))
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
                                        "退款复核已变化，需要重新加载服务端版本后再保存。账单不会回滚。",
                                        modifier = Modifier.weight(1f),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = tokens.warning,
                                    )
                                    OutlinedButton(
                                        onClick = {
                                            if (dirty) showReloadConfirm = true else load()
                                        },
                                        enabled = !saving && !recoveryBusy,
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text("重新加载") }
                                }
                            }
                        }

                        Column(
                            modifier = Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
                        ) {
                            Text(
                                "选择原单并填写精确分摊金额（元）",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                color = tokens.fg,
                                modifier = Modifier.padding(top = 6.dp, bottom = 2.dp),
                            )
                            Text(
                                "可从服务端返回的原单中选择，也可从普通支出账单中添加；金额不得超过原单剩余可退额度。",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.muted,
                            )
                            val visibleCandidates = candidates.values.sortedBy { it.date }
                            if (visibleCandidates.isEmpty()) {
                                Text(
                                    "当前没有可分摊的原单，请从账单中选择。",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = tokens.muted,
                                    modifier = Modifier.padding(vertical = 12.dp),
                                )
                            }
                            visibleCandidates.forEach { candidate ->
                                val selected = draft.containsKey(candidate.originalId)
                                CandidateSplitRow(
                                    candidate = candidate,
                                    selected = selected,
                                    amountText = draft[candidate.originalId].orEmpty(),
                                    isLegacy = candidate.originalId in loaded.legacyOriginalIds,
                                    enabled = !saving && !recoveryBusy && !addingOriginals,
                                    onToggle = { checked ->
                                        draft = if (checked) {
                                            val total = currentTotal ?: 0L
                                            val amount = min(
                                                candidate.remainingCents,
                                                (loaded.amountCents - total).coerceAtLeast(0L),
                                            )
                                            if (amount > 0L) {
                                                draft + (candidate.originalId to FinancialPlanMoneyParser.formatCentsToYuan(amount))
                                            } else {
                                                draft + (candidate.originalId to "")
                                            }
                                        } else {
                                            draft - candidate.originalId
                                        }
                                    },
                                    onAmountChange = { value ->
                                        draft = draft + (candidate.originalId to value)
                                    },
                                )
                            }

                            Spacer(Modifier.height(8.dp))
                            LedgerLinkPicker(
                                api = api,
                                type = 0,
                                selected = externalCandidates.keys,
                                multiple = true,
                                onAuthExpired = onAuthExpired,
                                onSelect = { ids ->
                                    val removed = externalCandidates.keys - ids
                                    if (removed.isNotEmpty()) {
                                        externalCandidates = externalCandidates - removed
                                        draft = draft - removed
                                    }
                                    val added = ids - externalCandidates.keys
                                    if (added.isNotEmpty()) addOriginals(added)
                                },
                            )
                            if (addingOriginals) {
                                Row(
                                    Modifier.fillMaxWidth().padding(top = 6.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    CircularProgressIndicator(modifier = Modifier.width(16.dp).height(16.dp), strokeWidth = 2.dp)
                                    Text("正在读取原单用途令牌…", style = MaterialTheme.typography.bodySmall, color = tokens.muted)
                                }
                            }

                            loaded.suggestedSplits?.let {
                                Spacer(Modifier.height(6.dp))
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        "服务端根据唯一旧关联给出建议，但不会自动确认。",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = tokens.muted,
                                        modifier = Modifier.weight(1f),
                                    )
                                    OutlinedButton(
                                        onClick = {
                                            FinancialRefundDraftLogic.suggestedDraft(loaded)?.let { suggested ->
                                                draft = suggested
                                            }
                                        },
                                        enabled = !saving && !recoveryBusy && !addingOriginals,
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text("采用建议") }
                                }
                            }

                            if (draft.values.any { it.isNotBlank() }) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        "本页合计 ¥${currentTotal?.let { formatYuan(it) } ?: "—"}",
                                        style = MaterialTheme.typography.bodySmall,
                                        fontWeight = FontWeight.Medium,
                                        color = tokens.fg,
                                    )
                                    TextButton(
                                        onClick = { draft = emptyMap() },
                                        enabled = !saving && !recoveryBusy && !addingOriginals,
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text("清空分摊") }
                                }
                            }

                            val pendingAmount = pendingCents ?: loaded.amountCents
                            if (pendingAmount > 0L) {
                                Surface(
                                    color = tokens.warning.copy(alpha = 0.10f),
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                                ) {
                                    Text(
                                        "尚有 ¥${formatYuan(pendingAmount)} 未分配：保存后将明确保持“待分摊/待审核”，不会自动计入任何周期或用途。",
                                        modifier = Modifier.padding(10.dp),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = tokens.warning,
                                    )
                                }
                            } else if (draft.values.any { it.isNotBlank() }) {
                                Text(
                                    "已按原单精确分配全部退款金额。",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = tokens.ok,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                            Spacer(Modifier.height(12.dp))
                        }

                        HorizontalDivider()
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            OutlinedButton(
                                onClick = { requestClose() },
                                enabled = !saving && !recoveryBusy && !addingOriginals,
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            ) { Text("取消") }
                            Button(
                                onClick = { save() },
                                enabled = !saving && !recoveryBusy && !addingOriginals && !conflict &&
                                    pendingOp == null &&
                                    loaded.state != FinancialRefundState.DELETED &&
                                    loaded.state != FinancialRefundState.PURGED &&
                                    loaded.state != FinancialRefundState.NOT_REFUND,
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
                                    Text(if (dirty) "确认分摊" else "无修改")
                                }
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
            title = { Text("放弃未保存的分摊修改？") },
            text = { Text("当前分摊修改尚未保存。关闭后本次修改会丢弃；账单本身保持已保存。") },
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

    if (showReloadConfirm) {
        AlertDialog(
            onDismissRequest = { showReloadConfirm = false },
            title = { Text("放弃修改并重新加载？") },
            text = { Text("将丢弃本页未保存的分摊修改，并读取服务端最新退款复核。账单本身不会被修改。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showReloadConfirm = false
                        load()
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("重新加载") }
            },
            dismissButton = {
                TextButton(
                    onClick = { showReloadConfirm = false },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("继续编辑") }
            },
        )
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清空现有退款分摊？") },
            text = { Text("这会整份替换现有分摊为空，退款将回到未归属/待审核状态；账单本身保持已保存。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmClear = false
                        save(forceClear = true)
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("清空并保存") }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmClear = false },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("取消") }
            },
        )
    }
}

@Composable
private fun CandidateSplitRow(
    candidate: FinancialRefundCandidate,
    selected: Boolean,
    amountText: String,
    isLegacy: Boolean,
    enabled: Boolean,
    onToggle: (Boolean) -> Unit,
    onAmountChange: (String) -> Unit,
) {
    val tokens = LocalWebTokens.current
    Surface(
        color = if (selected) tokens.accentSubtle else tokens.surfaceSoft,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, if (selected) tokens.accent.copy(alpha = 0.5f) else tokens.border.copy(alpha = 0.6f)),
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = selected,
                    onCheckedChange = onToggle,
                    enabled = enabled && candidate.selectable,
                )
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "原单 ${candidate.originalId.take(10)}…",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            color = tokens.fg,
                        )
                        if (isLegacy) {
                            Text(
                                " 旧关联",
                                fontSize = 10.sp,
                                color = tokens.warning,
                            )
                        }
                    }
                    Text(
                        "${formatDay(candidate.date)} · 原单 ¥${formatYuan(candidate.amountCents)} · 剩余可退 ¥${formatYuan(candidate.remainingCents)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = tokens.muted,
                    )
                    if (candidate.otherConfirmedRefundCents > 0L) {
                        Text(
                            "其他已确认退款 ¥${formatYuan(candidate.otherConfirmedRefundCents)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = tokens.warning,
                        )
                    }
                    if (!candidate.selectable) {
                        Text(
                            when (candidate.state) {
                                FinancialRefundOriginalState.DELETED -> "原单已删除，不能分摊"
                                FinancialRefundOriginalState.PURGED -> "原单已清除，不能分摊"
                                FinancialRefundOriginalState.NOT_EXPENSE -> "原单不是普通支出，不能分摊"
                                FinancialRefundOriginalState.LIVE -> "原单当前不可分摊"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = tokens.danger,
                        )
                    }
                    if (candidate.isExternal && candidate.otherConfirmedRefundCents == 0L &&
                        candidate.remainingCents == candidate.amountCents
                    ) {
                        Text(
                            "剩余额度以服务端校验为准（本页未加载其他退款记录）",
                            style = MaterialTheme.typography.labelSmall,
                            color = tokens.muted,
                        )
                    }
                }
                if (selected) {
                    Text(
                        "¥${formatYuan(candidate.remainingCents)} 上限",
                        style = MaterialTheme.typography.labelSmall,
                        color = tokens.muted,
                    )
                }
            }
            if (selected) {
                OutlinedTextField(
                    value = amountText,
                    onValueChange = onAmountChange,
                    label = { Text("分摊金额（元）") },
                    enabled = enabled,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth().padding(start = 4.dp, top = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun PendingRefundRecoveryCard(
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
                "待恢复的退款分摊保存",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = tokens.warning,
            )
            Text(
                "操作 ${pending.operationId.take(8)}… 已在发送前保存。账单已保存；查询或重试只影响分摊。",
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

private fun refundStateLabel(review: FinancialRefundReview): String = when (review.state.wire) {
    "unconfirmed" -> "未确认"
    "confirmed" -> "已确认"
    "review-required" -> "待审核"
    "deleted" -> "已删除"
    "purged" -> "已清除"
    "not-refund" -> "不是退款"
    else -> review.state.wire
}
