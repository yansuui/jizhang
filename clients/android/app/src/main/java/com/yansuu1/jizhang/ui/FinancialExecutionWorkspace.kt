package com.yansuu1.jizhang.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialCurrentExecutionResponse
import com.yansuu1.jizhang.repo.FinancialExecution
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.FinancialExecutionUnsupportedException
import com.yansuu1.jizhang.repo.FinancialMappingPolicy
import com.yansuu1.jizhang.repo.FinancialPeriodConfirmRequest
import com.yansuu1.jizhang.repo.FinancialPeriodProposal
import com.yansuu1.jizhang.repo.FinancialPeriodReason
import com.yansuu1.jizhang.repo.FinancialPeriodSourceState
import com.yansuu1.jizhang.repo.FinancialPreview
import com.yansuu1.jizhang.repo.FinancialRefundReview
import com.yansuu1.jizhang.repo.FinancialSalarySource
import com.yansuu1.jizhang.repo.FinancialSourceSelection
import com.yansuu1.jizhang.repo.FinancialSpendExecution
import com.yansuu1.jizhang.repo.SpendingPurpose
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

/**
 * 代次管理与工作状态追踪，防止会话失效或切换服务导致过期响应生效。
 */
class FinancialExecutionWorkOwner {
    private var currentTicket: Long = 0L

    @Synchronized
    fun nextTicket(): Long {
        currentTicket++
        return currentTicket
    }

    @Synchronized
    fun isCurrent(ticket: Long): Boolean = ticket == currentTicket

    @Synchronized
    fun cancel() {
        currentTicket++
    }
}

@Composable
fun FinancialExecutionWorkspace(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    modifier: Modifier = Modifier,
    onRegisterGuard: (((onAllowLeave: () -> Unit) -> Unit) -> Unit)? = null,
    onDataChanged: () -> Unit = {},
) {
    val repo = remember(api) { FinancialExecutionRepository(api) }
    val scope = rememberCoroutineScope()
    val tokens = LocalWebTokens.current
    val workOwner = remember(api) { FinancialExecutionWorkOwner() }
    val refundWorkOwner = remember(api) { FinancialExecutionWorkOwner() }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }

    DisposableEffect(workOwner, refundWorkOwner) {
        onDispose {
            workOwner.cancel()
            refundWorkOwner.cancel()
        }
    }

    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var unsupportedByServer by remember { mutableStateOf(false) }

    var currentResponse by remember { mutableStateOf<FinancialCurrentExecutionResponse?>(null) }
    var reviewRefunds by remember { mutableStateOf<List<FinancialRefundReview>>(emptyList()) }
    var refundQueueError by remember { mutableStateOf<String?>(null) }
    var refundQueueLoading by remember { mutableStateOf(false) }
    var totalRefundQueueCount by remember { mutableStateOf(0L) }
    var showRefundsReviewDialog by remember { mutableStateOf(false) }
    var selectedRefundSplitTargetId by remember { mutableStateOf<String?>(null) }

    // 历史方案 Sheet 状态
    var showHistorySheet by remember { mutableStateOf(false) }

    // 从已有工资开启执行方案 Sheet 状态
    var showExistingSalarySheet by remember { mutableStateOf(false) }

    // 独立配置与分类映射 Sheet 状态
    var showConfigSheet by remember { mutableStateOf(false) }
    var showCategoryMappingSheet by remember { mutableStateOf(false) }

    // 未决操作扫描与恢复状态
    var pendingOperations by remember { mutableStateOf<List<PendingFinancialOperation>>(emptyList()) }
    var recoveringPending by remember { mutableStateOf(false) }
    var pendingRecoveryMessage by remember { mutableStateOf<String?>(null) }

    // 来源确认与对齐 Dialog 状态
    var showSourceReconcileDialog by remember { mutableStateOf(false) }
    var sourceLoading by remember { mutableStateOf(false) }
    var sourceLoadError by remember { mutableStateOf<String?>(null) }
    var availableSources by remember { mutableStateOf<List<FinancialSalarySource>>(emptyList()) }
    var selectedSourceIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var previewResult by remember { mutableStateOf<FinancialPreview?>(null) }
    var previewLoading by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var submittingAction by remember { mutableStateOf(false) }

    // 注册工作区离开守卫：若正在提交周期对齐/确认操作，拦截切 Tab 或退出
    fun requestLeave(onAllowLeave: () -> Unit) {
        if (submittingAction) {
            // 正在写操作，阻断退出并提示
            actionError = "正在提交方案更新，请等待完成后再切换页面。"
        } else {
            onAllowLeave()
        }
    }

    LaunchedEffect(onRegisterGuard) {
        onRegisterGuard?.invoke(::requestLeave)
    }

    fun scanAndRecoverPendingOperations() {
        scope.launch {
            val authScope = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (e is AuthExpiredException) onAuthExpired()
                return@launch
            }
            val list = replayStore.list(authScope.serverBaseUrl, authScope.storageIdentity).filter { op ->
                // 仅扫描并恢复本工作区理财周期与配置相关的操作，不抢占 salary 或 transaction editor 的并发未决
                op.path.startsWith("/api/v1/financial-planning/periods") ||
                    op.path.startsWith("/api/v1/financial-planning/config")
            }
            pendingOperations = list
            if (list.isEmpty()) return@launch

            recoveringPending = true
            try {
                for (op in list) {
                    try {
                        val result = repo.getOperation(op.operationId)
                        // 服务端已存在已提交结果，安全从本地未决表移除
                        replayStore.remove(authScope.serverBaseUrl, authScope.storageIdentity, op.operationId)
                        pendingRecoveryMessage = "已自动核对并回收已确认操作：${op.operationId.take(8)}..."
                    } catch (e: ApiException) {
                        if (e.status == 404) {
                            // 尚未查到已提交结果，可同一请求重放，保持在待重放列表
                            pendingRecoveryMessage = "尚未查到已提交结果，可使用同一请求重放（ID: ${op.operationId.take(8)}...）。"
                        } else {
                            pendingRecoveryMessage = "核对未决操作遇到错误：${e.message}"
                        }
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        if (e is AuthExpiredException) throw e
                    }
                }
                pendingOperations = replayStore.list(authScope.serverBaseUrl, authScope.storageIdentity).filter { op ->
                    op.path.startsWith("/api/v1/financial-planning/periods") ||
                        op.path.startsWith("/api/v1/financial-planning/config")
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } finally {
                recoveringPending = false
            }
        }
    }

    fun loadReviewRefunds() {
        val ticket = refundWorkOwner.nextTicket()
        scope.launch {
            refundQueueLoading = true
            refundQueueError = null
            try {
                val refundsResp = repo.getRefunds(state = "review-required", limit = 10, offset = 0)
                if (refundWorkOwner.isCurrent(ticket)) {
                    reviewRefunds = refundsResp.items
                    totalRefundQueueCount = refundsResp.total
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                if (refundWorkOwner.isCurrent(ticket)) onAuthExpired()
            } catch (e: Exception) {
                if (refundWorkOwner.isCurrent(ticket)) {
                    refundQueueError = e.message ?: "读取待审核退款失败"
                }
            } finally {
                if (refundWorkOwner.isCurrent(ticket)) {
                    refundQueueLoading = false
                }
            }
        }
    }

    fun refreshExecution() {
        val ticket = workOwner.nextTicket()
        scope.launch {
            loading = true
            loadError = null
            unsupportedByServer = false
            try {
                // 1. 验证 capabilities 确认支持 Phase 1
                try {
                    repo.getCapabilities()
                } catch (e: FinancialExecutionUnsupportedException) {
                    if (workOwner.isCurrent(ticket)) {
                        unsupportedByServer = true
                        loading = false
                    }
                    return@launch
                }
                coroutineContext.ensureActive()

                // 2. 扫描并尝试恢复未决操作
                scanAndRecoverPendingOperations()

                // 3. 加载当前执行数据
                val execResp = repo.getCurrentExecution()
                coroutineContext.ensureActive()
                if (workOwner.isCurrent(ticket)) {
                    currentResponse = execResp
                }

                // Refund queue owns a separate ticket; retrying it must never leave
                // the execution refresh stuck in loading (and vice versa).
                if (workOwner.isCurrent(ticket)) loadReviewRefunds()
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                if (workOwner.isCurrent(ticket)) onAuthExpired()
            } catch (e: Exception) {
                if (workOwner.isCurrent(ticket)) {
                    loadError = e.message ?: "加载四用途执行数据失败"
                }
            } finally {
                if (workOwner.isCurrent(ticket)) {
                    loading = false
                }
            }
        }
    }

    LaunchedEffect(api) {
        refreshExecution()
    }

    if (unsupportedByServer) {
        Box(
            modifier = modifier.fillMaxSize().padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.Info,
                    contentDescription = null,
                    tint = tokens.muted,
                    modifier = Modifier.size(48.dp),
                )
                Text(
                    text = "当前服务端未接入四用途执行系统",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = tokens.fg,
                )
                Text(
                    text = "您仍可使用上方的「分类信封预算」查看日常预算，或使用「测算预估」规划 25/15/50/10 资产方案。",
                    style = MaterialTheme.typography.bodySmall,
                    color = tokens.muted,
                )
                OutlinedButton(onClick = { refreshExecution() }) {
                    Text("重试连接")
                }
            }
        }
        return
    }

    if (loading && currentResponse == null) {
        Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    if (loadError != null && currentResponse == null) {
        Box(modifier = modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = tokens.danger,
                    modifier = Modifier.size(48.dp),
                )
                Text(
                    text = loadError ?: "加载失败",
                    style = MaterialTheme.typography.bodyMedium,
                    color = tokens.danger,
                )
                Button(onClick = { refreshExecution() }) {
                    Text("重试")
                }
            }
        }
        return
    }

    val exec = currentResponse?.execution

    fun openSourceFlow() {
        val execPeriod = exec?.period
        showSourceReconcileDialog = true
        sourceLoading = true
        sourceLoadError = null
        previewResult = null
        actionError = null
        scope.launch {
            try {
                val groupMonth = execPeriod?.window?.groupMonth
                val resp = repo.getSalarySources(groupMonth = groupMonth, limit = 50)
                availableSources = resp.items
                // 默认选中当前周期已包含的所有来源
                selectedSourceIds = execPeriod?.sources?.map { it.salaryId }?.toSet()
                    ?: resp.items.filter { it.selectable }.map { it.salaryId }.toSet()
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                sourceLoadError = e.message ?: "加载发薪来源失败"
            } finally {
                sourceLoading = false
            }
        }
    }

    fun executePreview(reason: FinancialPeriodReason) {
        val execPeriod = exec?.period ?: return
        val currentCfgRev = execPeriod.decision.configRevision
        val currentMapRev = execPeriod.decision.mappingRevision
        val selections = availableSources
            .filter { it.salaryId in selectedSourceIds }
            .map { FinancialSourceSelection(it.salaryId, it.sourceToken) }

        if (selections.isEmpty()) {
            actionError = "请至少选择一笔发薪来源"
            return
        }

        previewLoading = true
        actionError = null
        scope.launch {
            try {
                val proposal = FinancialPeriodProposal(
                    periodId = execPeriod.id,
                    expectedRevision = execPeriod.revision,
                    expectedConfigRevision = currentCfgRev,
                    expectedMappingRevision = currentMapRev,
                    selectedSources = selections,
                    mappingPolicy = FinancialMappingPolicy.PRESERVE,
                    reason = reason,
                )
                val p = repo.previewPeriod(proposal)
                previewResult = p
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = e.message ?: "方案试算失败"
            } finally {
                previewLoading = false
            }
        }
    }

    fun submitConfirmOrReconcile(isReconcile: Boolean) {
        val p = previewResult ?: return
        val execPeriod = exec?.period ?: return
        submittingAction = true
        actionError = null
        scope.launch {
            val opId = UUID.randomUUID().toString()
            val request = FinancialPeriodConfirmRequest(
                operationId = opId,
                proposal = p.proposal,
                previewToken = p.previewToken,
            )
            val authScope = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (e is AuthExpiredException) onAuthExpired()
                actionError = "获取认证上下文失败：${e.message}"
                submittingAction = false
                return@launch
            }
            val pendingOp = PendingFinancialOperation(
                operationId = opId,
                method = "POST",
                path = if (isReconcile) "/api/v1/financial-planning/periods/${execPeriod.id}/reconcile" else "/api/v1/financial-planning/periods/confirm",
                payloadJson = request.toJson().toString(),
                expectedRevision = execPeriod.revision,
            )
            var committed = false
            try {
                replayStore.record(authScope.serverBaseUrl, authScope.storageIdentity, pendingOp)
                if (isReconcile) {
                    repo.reconcilePeriod(execPeriod.id, request)
                } else {
                    repo.confirmPeriod(request)
                }
                committed = true
                showSourceReconcileDialog = false
                onDataChanged()

                var cleanupFailed = false
                try {
                    replayStore.remove(authScope.serverBaseUrl, authScope.storageIdentity, opId)
                } catch (_: Exception) {
                    cleanupFailed = true
                }
                var refreshFailed = false
                try {
                    refreshExecution()
                } catch (_: Exception) {
                    refreshFailed = true
                }
                if (cleanupFailed || refreshFailed) {
                    actionError = "方案已确认，数据待刷新/本地核对仍待处理。"
                }
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!committed) {
                    actionError = e.message ?: "提交方案失败，可核对后重试"
                }
            } finally {
                submittingAction = false
            }
        }
    }

    LazyColumn(
        modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { Spacer(Modifier.height(8.dp)) }

        // 刷新中显式进度反馈
        if (loading && currentResponse != null) {
            item {
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp),
                    color = tokens.accent,
                    trackColor = tokens.accent.copy(alpha = 0.2f),
                )
            }
        }

        // 刷新错误显式提示（保留旧数据同时告知用户刷新失败）
        if (loadError != null && currentResponse != null) {
            item {
                Surface(
                    color = tokens.danger.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Warning, contentDescription = null, tint = tokens.danger)
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = "数据刷新失败: $loadError",
                                style = MaterialTheme.typography.bodySmall,
                                color = tokens.danger,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                text = "当前仍展示上次成功加载的方案内容",
                                fontSize = 11.sp,
                                color = tokens.muted,
                            )
                        }
                        OutlinedButton(
                            onClick = { refreshExecution() },
                            enabled = !loading,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text("重试", fontSize = 12.sp)
                        }
                    }
                }
            }
        }

        // 未决离线操作警示横幅
        if (pendingOperations.isNotEmpty()) {
            item {
                Surface(
                    color = tokens.warning.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Filled.Warning, contentDescription = null, tint = tokens.warning)
                            Text("存在 ${pendingOperations.size} 笔待核对/重放的离线操作", fontWeight = FontWeight.Bold, color = tokens.warning)
                        }
                        pendingRecoveryMessage?.let { Text(it, fontSize = 12.sp, color = tokens.fg) }
                        OutlinedButton(
                            onClick = { scanAndRecoverPendingOperations() },
                            enabled = !recoveringPending,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text(if (recoveringPending) "正在核对..." else "重新核对", fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        // 待审核退款横幅提示：区分加载失败与正常数量，提供 >=48dp 无障碍操作
        if (reviewRefunds.isNotEmpty() || refundQueueError != null) {
            item {
                FinanceCard(
                    modifier = Modifier.fillMaxWidth(),
                    backgroundColor = if (refundQueueError != null) tokens.danger.copy(alpha = 0.08f) else tokens.warning.copy(alpha = 0.08f),
                    borderColor = if (refundQueueError != null) tokens.danger.copy(alpha = 0.3f) else tokens.warning.copy(alpha = 0.3f),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(
                                Icons.Filled.Warning,
                                contentDescription = null,
                                tint = if (refundQueueError != null) tokens.danger else tokens.warning,
                            )
                            Column {
                                if (refundQueueError != null) {
                                    Text(
                                        text = "待审核退款读取失败",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = tokens.danger,
                                    )
                                    Text(
                                        text = refundQueueError!!,
                                        fontSize = 11.sp,
                                        color = tokens.muted,
                                    )
                                } else {
                                    Text(
                                        text = "有 $totalRefundQueueCount 笔退款待审核归属分摊",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = tokens.warning,
                                    )
                                }
                            }
                        }

                        if (refundQueueError != null) {
                            OutlinedButton(
                                onClick = { loadReviewRefunds() },
                                enabled = !refundQueueLoading,
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text(if (refundQueueLoading) "重试中..." else "重试加载", fontSize = 12.sp)
                            }
                        } else {
                            Button(
                                onClick = { showRefundsReviewDialog = true },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text("查看", fontSize = 12.sp)
                            }
                        }
                    }
                }
            }
        }

        if (exec == null) {
            item {
                FinanceCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = "当前周期暂无四用途执行方案",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            text = "在发薪日记录工资后，即可确认该周期的四用途分配方案；历史周期也可以在核对后补录确认。\n\n提示：若您此前在「测算预估」中保存过方案，该方案已保存在「测算预估」标签页中（包含税后收入与必要开支试算）；四用途执行周期需在工资保存后另行确认；仅保存工资或试算不会创建周期。",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.muted,
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Button(
                                onClick = { showExistingSalarySheet = true },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text("从已有工资开启")
                            }
                            OutlinedButton(
                                onClick = { showConfigSheet = true },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text("规划设置")
                            }
                            OutlinedButton(
                                onClick = { showHistorySheet = true },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text("历史方案")
                            }
                            OutlinedButton(
                                onClick = { refreshExecution() },
                                enabled = !loading,
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                if (loading) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        color = tokens.fg,
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text("刷新中...")
                                } else {
                                    Icon(Icons.Filled.Refresh, contentDescription = null)
                                    Spacer(Modifier.width(6.dp))
                                    Text("刷新状态")
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // 周期概览卡片
            item {
                val period = exec.period
                FinanceCard(modifier = Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Column {
                                Text(
                                    text = "周期：${period.window.groupMonth}",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = tokens.fg,
                                )
                                Text(
                                    text = "确认收入：¥${formatYuan(period.confirmedIncomeCents)} (版本 r${period.revision})",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = tokens.muted,
                                )
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                OutlinedButton(
                                    onClick = { showHistorySheet = true },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) {
                                    Text("历史方案", fontSize = 11.sp)
                                }
                                OutlinedButton(
                                    onClick = { showExistingSalarySheet = true },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) {
                                    Text("已有工资", fontSize = 11.sp)
                                }
                                OutlinedButton(
                                    onClick = { showCategoryMappingSheet = true },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) {
                                    Text("映射规则", fontSize = 11.sp)
                                }
                                OutlinedButton(
                                    onClick = { showConfigSheet = true },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) {
                                    Text("规划设置", fontSize = 11.sp)
                                }
                                IconButton(
                                    onClick = { openSourceFlow() },
                                    modifier = Modifier.size(48.dp),
                                ) {
                                    Icon(Icons.Filled.Settings, contentDescription = "对齐来源", tint = tokens.fg)
                                }
                                IconButton(
                                    onClick = { refreshExecution() },
                                    enabled = !loading,
                                    modifier = Modifier.size(48.dp),
                                ) {
                                    Icon(
                                        Icons.Filled.Refresh,
                                        contentDescription = "刷新",
                                        tint = if (loading) tokens.muted else tokens.fg,
                                    )
                                }
                            }
                        }

                        // 收入源变更警告
                        if (period.sourceState != FinancialPeriodSourceState.VALID) {
                            Surface(
                                color = tokens.warning.copy(alpha = 0.1f),
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(
                                    modifier = Modifier.padding(10.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(Icons.Filled.Warning, contentDescription = null, tint = tokens.warning)
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            text = "工资源事实已变动或被修改，建议核对并重算当前周期执行方案。",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = tokens.warning,
                                        )
                                    }
                                    OutlinedButton(
                                        onClick = { openSourceFlow() },
                                        modifier = Modifier.height(32.dp),
                                    ) {
                                        Text("重新对齐", fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 四用途执行明细
            item {
                Text(
                    text = "四用途执行进度",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = tokens.fg,
                )
            }

            // 1. 必要开支 50%
            val essentials = exec.spending.firstOrNull { it.purpose == SpendingPurpose.ESSENTIALS }
            if (essentials != null) {
                item {
                    PurposeSpendCard(
                        title = "必要开支 · 50%",
                        description = "生活底线 · 固定必须支出",
                        spend = essentials,
                        accentColor = tokens.accent,
                    )
                }
            }

            // 2. 随心消费 10%
            val joy = exec.spending.firstOrNull { it.purpose == SpendingPurpose.JOY }
            if (joy != null) {
                item {
                    PurposeSpendCard(
                        title = "随心消费 · 10%",
                        description = "活力犒劳 · 当下愿望享受",
                        spend = joy,
                        accentColor = Color(0xFFE28B3B),
                    )
                }
            }

            // 3. 成长积累 25% (未接入真实划拨)
            item {
                val growthTarget = exec.period.decision.targets.growth
                PurposeFundingCard(
                    title = "成长积累 · 25%",
                    description = "投资与技能提升 · 目标 ¥${formatYuan(growthTarget)}",
                )
            }

            // 4. 应急储备 15% (未接入真实划拨)
            item {
                val reserveTarget = exec.period.decision.targets.reserve
                PurposeFundingCard(
                    title = "应急储备 · 15%",
                    description = "安全防线 · 目标 ¥${formatYuan(reserveTarget)}",
                )
            }

            // 分类信封预算参考对比卡片
            val envRef = exec.envelopeReference
            item {
                FinanceCard(modifier = Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            text = "分类信封预算对照（参考视图）",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            color = tokens.fg,
                        )
                        Text(
                            text = "分类信封总额：¥${formatYuan(envRef.totalBudgetCents)} | 60%执行支出上限：¥${formatYuan(envRef.purposeSpendingCeilingCents)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.muted,
                        )
                        if (envRef.differenceCents != 0L) {
                            Text(
                                text = if (envRef.differenceCents > 0)
                                    "提示：分类信封总预算高出四用途支出上限 ¥${formatYuan(envRef.differenceCents)}"
                                else
                                    "提示：分类信封总预算低于四用途支出上限 ¥${formatYuan(-envRef.differenceCents)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (envRef.differenceCents > 0) tokens.warning else tokens.muted,
                            )
                        }
                    }
                }
            }
        }

        item { Spacer(Modifier.height(24.dp)) }
    }

    // 来源核对与重算 Dialog
    if (showSourceReconcileDialog) {
        AlertDialog(
            onDismissRequest = { if (!submittingAction) showSourceReconcileDialog = false },
            title = { Text("周期来源核对与对齐") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (sourceLoading) {
                        CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                    } else if (sourceLoadError != null) {
                        Text(sourceLoadError!!, color = tokens.danger)
                    } else {
                        Text("请勾选本周期计入确认的有效工资：", fontSize = 12.sp, color = tokens.muted)
                        availableSources.forEach { s ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Checkbox(
                                    checked = s.salaryId in selectedSourceIds,
                                    onCheckedChange = { checked ->
                                        selectedSourceIds = if (checked) {
                                            selectedSourceIds + s.salaryId
                                        } else {
                                            selectedSourceIds - s.salaryId
                                        }
                                        previewResult = null // 清除失效预览
                                    },
                                )
                                Column {
                                    Text("¥${formatYuan(s.amountCents)} · ${s.proposedGroupMonth}")
                                    Text("Token: ${s.sourceToken.take(8)}...", fontSize = 10.sp, color = tokens.muted)
                                }
                            }
                        }

                        if (previewLoading) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                        }

                        previewResult?.let { p ->
                            Surface(
                                color = Color(0xFFF7F5F0),
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text("试算收入：¥${formatYuan(p.decision.incomeCents)}", fontWeight = FontWeight.Bold)
                                    Text("必要开支 50% 额度：¥${formatYuan(p.decision.targets.essentials)}")
                                    Text("随心消费 10% 额度：¥${formatYuan(p.decision.targets.joy)}")
                                }
                            }
                        }

                        actionError?.let { Text(it, color = tokens.danger, fontSize = 12.sp) }
                    }
                }
            },
            confirmButton = {
                if (previewResult == null) {
                    Button(
                        onClick = { executePreview(FinancialPeriodReason.INCOME_RECONCILIATION) },
                        enabled = !previewLoading && !sourceLoading && selectedSourceIds.isNotEmpty(),
                    ) {
                        Text("试算方案")
                    }
                } else {
                    Button(
                        onClick = { submitConfirmOrReconcile(isReconcile = true) },
                        enabled = !submittingAction,
                    ) {
                        if (submittingAction) CircularProgressIndicator(Modifier.size(16.dp), color = Color.White)
                        else Text("确认并更新")
                    }
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showSourceReconcileDialog = false },
                    enabled = !submittingAction,
                ) { Text("取消") }
            },
        )
    }

    if (showRefundsReviewDialog) {
        AlertDialog(
            onDismissRequest = { showRefundsReviewDialog = false },
            title = { Text("待审核退款列表") },
            text = {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (refundQueueError != null) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        ) {
                            Text("加载待审核退款失败：$refundQueueError", color = tokens.danger, fontSize = 13.sp)
                            OutlinedButton(
                                onClick = { loadReviewRefunds() },
                                enabled = !refundQueueLoading,
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text(if (refundQueueLoading) "重试中..." else "重试加载", fontSize = 12.sp)
                            }
                        }
                    } else if (refundQueueLoading) {
                        Box(modifier = Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                        }
                    } else if (reviewRefunds.isEmpty()) {
                        Text("暂无待审核退款。")
                    } else {
                        reviewRefunds.forEach { review ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text("退款 ¥${formatYuan(review.amountCents)}")
                                    Text("状态: ${review.state.wire} · 未分摊 ¥${formatYuan(review.unresolvedCents)}", fontSize = 11.sp, color = tokens.muted)
                                }
                                Button(
                                    onClick = {
                                        selectedRefundSplitTargetId = review.refundTransactionId
                                        showRefundsReviewDialog = false
                                    },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) {
                                    Text("拆分分摊", fontSize = 12.sp)
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = { showRefundsReviewDialog = false },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text("关闭")
                }
            },
        )
    }

    if (showHistorySheet) {
        FinancialExecutionHistorySheet(
            api = api,
            onAuthExpired = onAuthExpired,
            onClose = { showHistorySheet = false },
        )
    }

    if (showExistingSalarySheet) {
        ExistingSalaryExecutionSheet(
            api = api,
            onAuthExpired = onAuthExpired,
            onOpenConfig = { showConfigSheet = true },
            onSaved = {
                refreshExecution()
                onDataChanged()
            },
            onClose = { showExistingSalarySheet = false },
        )
    }

    if (showConfigSheet) {
        FinancialConfigSheet(
            api = api,
            onAuthExpired = onAuthExpired,
            onSaved = {
                refreshExecution()
                onDataChanged()
            },
            onClose = { showConfigSheet = false },
        )
    }

    if (showCategoryMappingSheet) {
        FinancialCategoryMappingSheet(
            api = api,
            onAuthExpired = onAuthExpired,
            onSaved = {
                refreshExecution()
                onDataChanged()
            },
            onClose = { showCategoryMappingSheet = false },
        )
    }

    selectedRefundSplitTargetId?.let { refundId ->
        FinancialRefundSplitDialog(
            api = api,
            refundTransactionId = refundId,
            onAuthExpired = onAuthExpired,
            onSaved = {
                refreshExecution()
                onDataChanged()
            },
            onClose = { selectedRefundSplitTargetId = null },
        )
    }
}

@Composable
private fun PurposeSpendCard(
    title: String,
    description: String,
    spend: FinancialSpendExecution,
    accentColor: Color,
) {
    val tokens = LocalWebTokens.current
    val progress = if (spend.targetCents > 0L) {
        (spend.netCents.toFloat() / spend.targetCents.toFloat()).coerceIn(0f, 1f)
    } else 0f

    FinanceCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(text = title, fontSize = 13.5.sp, fontWeight = FontWeight.Bold, color = tokens.fg)
                    Text(text = description, fontSize = 11.sp, color = tokens.muted)
                }
                Text(
                    text = "剩余 ¥${formatYuan(spend.remainingCents)}",
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    color = if (spend.overspendCents > 0L) tokens.danger else tokens.fg,
                )
            }

            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
                color = if (spend.overspendCents > 0L) tokens.danger else accentColor,
                trackColor = Color(0xFFE9E7E1),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "净支出 ¥${formatYuan(spend.netCents)} (毛 ¥${formatYuan(spend.grossCents)} - 退 ¥${formatYuan(spend.attributedRefundCents)})",
                    fontSize = 11.sp,
                    color = tokens.muted,
                )
                Text(
                    text = "限额 ¥${formatYuan(spend.targetCents)}",
                    fontSize = 11.sp,
                    color = tokens.muted,
                )
            }
        }
    }
}

@Composable
private fun PurposeFundingCard(
    title: String,
    description: String,
) {
    val tokens = LocalWebTokens.current
    FinanceCard(
        modifier = Modifier.fillMaxWidth(),
        backgroundColor = Color(0xFFFAF9F8),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(text = title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = tokens.fg)
                Text(text = description, fontSize = 11.sp, color = tokens.muted)
            }
            Surface(
                color = Color(0xFFECEAE6),
                shape = RoundedCornerShape(12.dp),
            ) {
                Text(
                    text = "未接入实际划拨",
                    fontSize = 10.5.sp,
                    color = tokens.muted,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
    }
}
