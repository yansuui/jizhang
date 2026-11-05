package com.yansuu1.jizhang.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialConfigResponse
import com.yansuu1.jizhang.repo.FinancialExecutionContract
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.FinancialExecutionUnsupportedException
import com.yansuu1.jizhang.repo.FinancialMappingPolicy
import com.yansuu1.jizhang.repo.FinancialPeriod
import com.yansuu1.jizhang.repo.FinancialPeriodConfirmRequest
import com.yansuu1.jizhang.repo.FinancialPeriodProposal
import com.yansuu1.jizhang.repo.FinancialPeriodReason
import com.yansuu1.jizhang.repo.FinancialPeriodSourceState
import com.yansuu1.jizhang.repo.FinancialPreview
import com.yansuu1.jizhang.repo.FinancialSalarySource
import com.yansuu1.jizhang.repo.FinancialSourceSelection
import com.yansuu1.jizhang.repo.FinancialSourceStatus
import com.yansuu1.jizhang.repo.MetaRepository
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * 格式化时间戳为指定服务端时区的日期文本 (YYYY-MM-DD)。
 */
internal fun formatEpochDateInZone(epochMs: Long, timeZoneId: String?): String {
    val zone = if (!timeZoneId.isNullOrBlank()) {
        try {
            TimeZone.getTimeZone(timeZoneId)
        } catch (_: Exception) {
            TimeZone.getDefault()
        }
    } else {
        TimeZone.getDefault()
    }
    return SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).apply {
        timeZone = zone
    }.format(Date(epochMs))
}

/**
 * 全量分页拉取所有历史已确认理财周期，避免单页100条限制导致的静默截断与遗漏。
 * 严格校验分页一致性：遇到 offset < total 返回空、total 突变、重复 ID 立即 Fail-closed 抛错。
 */
internal suspend fun fetchAllPeriodsPaginated(
    repo: FinancialExecutionRepository,
): List<FinancialPeriod> = withContext(Dispatchers.IO) {
    val all = mutableListOf<FinancialPeriod>()
    var offset = 0
    val limit = FinancialExecutionContract.MAX_PAGE_SIZE
    var expectedTotal: Long? = null

    while (true) {
        val resp = repo.getPeriods(limit = limit, offset = offset)
        if (expectedTotal == null) {
            expectedTotal = resp.total
        } else if (resp.total != expectedTotal) {
            throw IllegalStateException("周期总数在分页读取期间发生变更（从 $expectedTotal 变为 ${resp.total}），分页不一致")
        }

        if (resp.items.isEmpty()) {
            if (offset < resp.total) {
                throw IllegalStateException("分页数据不一致：返回为空但 offset ($offset) < total (${resp.total})")
            }
            break
        }

        all.addAll(resp.items)
        offset += resp.items.size
        if (offset >= resp.total) break
    }

    val ids = all.map { it.id }
    if (ids.size != ids.toSet().size) {
        throw IllegalStateException("获取到重复的理财周期 ID，分页数据存在并发不一致")
    }
    all
}

/**
 * 用于已有工资创建/追加四用途理财周期的提案构建器。
 * 纯逻辑函数，便于隔离单测。
 */
object ExistingSalaryProposalBuilder {

    fun build(
        config: FinancialConfigResponse,
        sources: List<FinancialSalarySource>,
        periods: List<FinancialPeriod>,
    ): FinancialPeriodProposal? {
        if (!config.config.enabled) return null
        if (sources.isEmpty()) return null
        if (sources.any { !it.selectable || it.includedPeriodId != null }) return null

        val groupMonth = sources.first().proposedGroupMonth
        if (sources.any { it.proposedGroupMonth != groupMonth }) return null

        val matching = periods.filter { it.window.groupMonth == groupMonth }
        // 存在多个相同月份的已有周期时属于歧义数据，拒绝盲目猜测追加
        if (matching.size > 1) return null
        val existing = matching.singleOrNull()

        val selected = linkedMapOf<String, FinancialSourceSelection>()
        if (existing != null) {
            // 已有周期的来源状态必须有效；若已被变动/删除则必须走 Reconcile 对齐流程，不可静默丢弃变更
            if (existing.sourceState != FinancialPeriodSourceState.VALID) return null

            existing.sources
                .filter { it.status == FinancialSourceStatus.VALID }
                .forEach { snapshot ->
                    selected[snapshot.salaryId] = FinancialSourceSelection(
                        salaryId = snapshot.salaryId,
                        expectedSourceToken = snapshot.sourceToken,
                    )
                }
        }
        for (source in sources) {
            selected[source.salaryId] = FinancialSourceSelection(
                salaryId = source.salaryId,
                expectedSourceToken = source.sourceToken,
            )
        }
        require(selected.size <= FinancialExecutionContract.MAX_SELECTED_SOURCES) {
            "理财周期来源超过 ${FinancialExecutionContract.MAX_SELECTED_SOURCES} 笔，无法自动预览。"
        }
        return FinancialPeriodProposal(
            periodId = existing?.id,
            expectedRevision = existing?.revision ?: 0L,
            expectedConfigRevision = config.config.revision,
            expectedMappingRevision = config.mappingRevision,
            selectedSources = selected.values.toList(),
            mappingPolicy = FinancialMappingPolicy.PRESERVE,
            reason = FinancialPeriodReason.SALARY_CONFIRMATION,
        )
    }
}

/**
 * 从已有工资开启/更新四用途执行周期的专用 BottomSheet。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExistingSalaryExecutionSheet(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onOpenConfig: () -> Unit,
    onSaved: () -> Unit,
    onClose: () -> Unit,
) {
    val repo = remember(api) { FinancialExecutionRepository(api) }
    val meta = remember(api) { MetaRepository(api) }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }
    val scope = rememberCoroutineScope()
    val tokens = LocalWebTokens.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // 状态定义
    var initialLoading by remember { mutableStateOf(true) }
    var initialError by remember { mutableStateOf<String?>(null) }
    var unsupported by remember { mutableStateOf(false) }

    // 配置与未决状态（记录捕获时的 scope 保证同一账号）
    var configResponse by remember { mutableStateOf<FinancialConfigResponse?>(null) }
    var pendingOperationToResolve by remember { mutableStateOf<PendingFinancialOperation?>(null) }
    var pendingOperationScope by remember { mutableStateOf<FinancialScope?>(null) }
    var resolvingPendingMessage by remember { mutableStateOf<String?>(null) }
    var replayingPending by remember { mutableStateOf(false) }

    // 账户字典 (id -> name)
    var accountNames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    // 工资分页列表状态
    val pageSize = 10
    var salaryOffset by remember { mutableStateOf(0) }
    var salaryTotal by remember { mutableStateOf(0L) }
    var salaryItems by remember { mutableStateOf<List<FinancialSalarySource>>(emptyList()) }
    var salaryListLoading by remember { mutableStateOf(false) }
    var salaryListError by remember { mutableStateOf<String?>(null) }

    // 选中状态 (salaryId -> FinancialSalarySource)
    var selectedSourcesMap by remember { mutableStateOf<Map<String, FinancialSalarySource>>(emptyMap()) }

    // 试算预览状态
    var previewing by remember { mutableStateOf(false) }
    var previewResult by remember { mutableStateOf<FinancialPreview?>(null) }
    var previewScope by remember { mutableStateOf<FinancialScope?>(null) }
    var previewError by remember { mutableStateOf<String?>(null) }
    var existingPeriodAmbiguityError by remember { mutableStateOf<String?>(null) }
    var existingPeriodMatching by remember { mutableStateOf<FinancialPeriod?>(null) }

    // 提交确认状态（绑定原持久化 scope）
    var confirming by remember { mutableStateOf(false) }
    var confirmError by remember { mutableStateOf<String?>(null) }
    var submittedSuccessfully by remember { mutableStateOf(false) }
    var loadedScope by remember { mutableStateOf<FinancialScope?>(null) }
    var activePendingConfirm by remember { mutableStateOf<PendingFinancialOperation?>(null) }
    var activePendingConfirmScope by remember { mutableStateOf<FinancialScope?>(null) }

    // 扫描未决并初始化
    fun scanAndInit() {
        scope.launch {
            initialLoading = true
            initialError = null
            unsupported = false
            resolvingPendingMessage = null
            pendingOperationToResolve = null
            pendingOperationScope = null
            try {
                // 1. 验证 capabilities
                val capabilities = try {
                    repo.getCapabilities()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                    return@launch
                } catch (e: FinancialExecutionUnsupportedException) {
                    unsupported = true
                    initialLoading = false
                    return@launch
                }
                if (!capabilities.executionSupported) {
                    unsupported = true
                    initialLoading = false
                    return@launch
                }

                // 2. 检查待重放未决操作 (Fail-closed)
                val authScope = try {
                    FinancialPrefs.resolveAuthenticatedScope(api)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                    return@launch
                } catch (e: Exception) {
                    initialError = "无法获取账号上下文：${e.message}"
                    initialLoading = false
                    return@launch
                }

                loadedScope = authScope
                val periodPendingOps = replayStore.list(authScope.serverBaseUrl, authScope.storageIdentity).filter { op ->
                    op.path == "/api/v1/financial-planning/periods/confirm" ||
                        (op.path.startsWith("/api/v1/financial-planning/periods/") && op.path.endsWith("/reconcile"))
                }

                if (periodPendingOps.isNotEmpty()) {
                    val pendingOp = periodPendingOps.first()
                    pendingOperationToResolve = pendingOp
                    pendingOperationScope = authScope
                    try {
                        val result = repo.getOperation(pendingOp.operationId)
                        // 校验 lookup 返回的 method/resource/operationId
                        val matched = result.operationId == pendingOp.operationId &&
                            result.method.equals(pendingOp.method, ignoreCase = true) &&
                            result.resource == pendingOp.path

                        val scopeNow = FinancialPrefs.resolveAuthenticatedScope(api)
                        if (matched && scopeNow.sameIdentity(authScope)) {
                            try {
                                replayStore.remove(authScope.serverBaseUrl, authScope.storageIdentity, pendingOp.operationId)
                                resolvingPendingMessage = "已自动确认并回收此前成功提交的操作（${pendingOp.operationId.take(8)}...），请刷新。"
                                pendingOperationToResolve = null
                                pendingOperationScope = null
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                resolvingPendingMessage = "此前操作已在服务端提交成功，但本地待重放记录清理失败：${e.message}"
                            }
                        } else {
                            resolvingPendingMessage = "服务端存在相同操作记录，但请求方法或路径不匹配，请核对。"
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: AuthExpiredException) {
                        onAuthExpired()
                        return@launch
                    } catch (e: ApiException) {
                        if (e.status == 404) {
                            // 404 lookup 不是未提交证明，绝对不静默删除，保持阻断并引导显式重放
                            resolvingPendingMessage = "检测到此前未完成的周期确认请求（单号: ${pendingOp.operationId.take(8)}...）。由于无法证明服务端未处理，已阻断发起新操作以防重复提交，请点击下方「重放原请求」完成提交。"
                        } else {
                            resolvingPendingMessage = "核对未决操作遇到错误：${e.message}"
                        }
                    } catch (e: Exception) {
                        resolvingPendingMessage = "无法联网核对未决操作（${e.message}），请稍后重试。"
                    }
                    initialLoading = false
                    return@launch
                }

                // 3. 加载理财配置
                val cfg = repo.getConfig()
                configResponse = cfg

                // 4. 加载账户信息用于安全展示真实账户名称（重新抛出 Cancellation 和 AuthExpired）
                try {
                    val accs = meta.accounts().optJSONArray("items")
                    accountNames = buildMap {
                        for (index in 0 until (accs?.length() ?: 0)) {
                            val account = accs?.optJSONObject(index) ?: continue
                            put(account.optString("id"), account.optString("name", "未命名账户"))
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                    return@launch
                } catch (_: Exception) {
                    // 仅当普通接口异常时降级为 ID
                }

                // 5. 若配置未开启，保持在配置提示状态，不加载工资
                if (!cfg.config.enabled) {
                    initialLoading = false
                    return@launch
                }

                // 6. 加载首页发薪来源
                salaryOffset = 0
                salaryListLoading = true
                try {
                    val sourcesResp = repo.getSalarySources(
                        groupMonth = null,
                        limit = pageSize,
                        offset = 0,
                    )
                    salaryItems = sourcesResp.items
                    salaryTotal = sourcesResp.total
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                    return@launch
                } catch (e: Exception) {
                    salaryListError = e.message ?: "加载发薪记录失败"
                } finally {
                    salaryListLoading = false
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: Exception) {
                initialError = e.message ?: "初始化失败"
            } finally {
                initialLoading = false
            }
        }
    }

    LaunchedEffect(api) {
        scanAndInit()
    }

    // 分页加载指定 offset 的工资数据
    fun loadSalaryPage(targetOffset: Int) {
        scope.launch {
            salaryListLoading = true
            salaryListError = null
            try {
                val resp = repo.getSalarySources(
                    groupMonth = null,
                    limit = pageSize,
                    offset = targetOffset,
                )
                salaryItems = resp.items
                salaryTotal = resp.total
                salaryOffset = targetOffset
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: Exception) {
                salaryListError = e.message ?: "加载工资列表失败"
            } finally {
                salaryListLoading = false
            }
        }
    }

    // 重放原未决操作：严格比对原始 scope 与当前 scope
    fun replayPendingOperation() {
        val op = pendingOperationToResolve ?: return
        val origScope = pendingOperationScope ?: return
        replayingPending = true
        scope.launch {
            try {
                val currentScope = FinancialPrefs.resolveAuthenticatedScope(api)
                if (!currentScope.sameIdentity(origScope)) {
                    resolvingPendingMessage = "当前登录用户或服务端地址已改变，与该待执行操作创建时的账户不一致，已阻断重放；请切回原登录账户。"
                    replayingPending = false
                    return@launch
                }

                repo.replayOperation(op.method, op.path, JSONObject(op.payloadJson))

                var cleanupError: String? = null
                try {
                    replayStore.remove(origScope.serverBaseUrl, origScope.storageIdentity, op.operationId)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    cleanupError = "已成功在服务端提交，但本地记录移除失败：${e.message}"
                }

                pendingOperationToResolve = null
                pendingOperationScope = null
                onSaved()
                if (cleanupError != null) {
                    resolvingPendingMessage = cleanupError
                } else {
                    onClose()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: Exception) {
                when (val failure = classifyFinancialWriteFailure(e)) {
                    is FinancialWriteFailure.Rejected -> {
                        // 服务端 4xx 确切拒绝，移除已作废的未决记录
                        try {
                            replayStore.remove(origScope.serverBaseUrl, origScope.storageIdentity, op.operationId)
                        } catch (ce: CancellationException) {
                            throw ce
                        } catch (_: Exception) {}
                        pendingOperationToResolve = null
                        pendingOperationScope = null
                        resolvingPendingMessage = "原操作已被服务端拒绝：${failure.message}"
                    }
                    is FinancialWriteFailure.Unknown -> {
                        resolvingPendingMessage = "重放结果仍未知：${failure.message}，已保留未决记录，可再次尝试。"
                    }
                    FinancialWriteFailure.AuthExpired -> onAuthExpired()
                }
            } finally {
                replayingPending = false
            }
        }
    }

    // 执行方案试算与全量历史周期比对
    fun executePreview() {
        val cfg = configResponse ?: return
        if (previewing || salaryListLoading) return
        val selectedSources = selectedSourcesMap.values.toList()
        if (selectedSources.isEmpty()) return

        previewing = true
        previewError = null
        existingPeriodAmbiguityError = null
        existingPeriodMatching = null
        scope.launch {
            try {
                // Bind the entire read and preview to one authenticated identity.
                val readScope = FinancialPrefs.resolveAuthenticatedScope(api)
                check(loadedScope?.sameIdentity(readScope) == true) { "账号或服务端已改变，请关闭后重新打开并选择工资。" }
                // 全量分页拉取历史周期
                val allPeriods = fetchAllPeriodsPaginated(repo)
                val targetGroupMonth = selectedSources.first().proposedGroupMonth
                val matchingPeriods = allPeriods.filter { it.window.groupMonth == targetGroupMonth }

                if (matchingPeriods.size > 1) {
                    existingPeriodAmbiguityError = "归属月份 $targetGroupMonth 存在多个已确认历史周期，数据存在歧义，为防误写已阻止自动追加；请联系管理员核对数据。"
                    previewing = false
                    return@launch
                }
                val existing = matchingPeriods.singleOrNull()
                existingPeriodMatching = existing

                // 检查已有周期的工资源状态是否要求 Reconcile
                if (existing != null && existing.sourceState != FinancialPeriodSourceState.VALID) {
                    existingPeriodAmbiguityError = "已有周期 (r${existing.revision}) 的发薪来源状态为 ${existing.sourceState.wire}（存在已修改或删除的来源），必须先在工作区进行来源对齐（Reconcile），无法直接追加新工资。"
                    previewing = false
                    return@launch
                }

                // 时区不同匹配不明时 fail closed，不能猜
                if (existing != null && existing.window.timeZone != cfg.config.timeZone) {
                    for (src in selectedSources) {
                        val monthInExistingZone = formatEpochDateInZone(src.date, existing.window.timeZone).take(7)
                        if (monthInExistingZone != existing.window.groupMonth) {
                            existingPeriodAmbiguityError = "发薪日期在已有周期时区 (${existing.window.timeZone}) 下归属月 ($monthInExistingZone) 与当前规划时区下的归属月 ($targetGroupMonth) 不一致，时区匹配不明，已阻断追加；请核对时区与发薪日期。"
                            previewing = false
                            return@launch
                        }
                    }
                }

                val proposal = ExistingSalaryProposalBuilder.build(cfg, selectedSources, allPeriods)
                if (proposal == null) {
                    previewError = "无法根据所选工资生成方案提案，请检查工资金额、归属月份及是否已被包含。"
                    previewing = false
                    return@launch
                }

                val preview = repo.previewPeriod(proposal)

                // 后端防碰撞与一致性强校验：若 preview.proposal.periodId 与所发送不一致或 warnings 含冲突，禁止确认
                if (preview.proposal.periodId != proposal.periodId) {
                    previewError = "服务端返回的周期 ID (${preview.proposal.periodId}) 与提案 (${proposal.periodId}) 不一致，可能存在并发周期变更，请重新刷新并试算。"
                    previewing = false
                    return@launch
                }
                if (preview.warnings.any { it.contains("PERIOD_ALREADY_EXISTS") || it.contains("CYCLE_COLLISION") }) {
                    previewError = "检测到周期冲突警告（已存在相同周期方案），禁止确认提交；请重新读取周期并重新试算。"
                    previewing = false
                    return@launch
                }

                val scopeAfter = FinancialPrefs.resolveAuthenticatedScope(api)
                check(readScope.sameIdentity(scopeAfter)) { "登录账号或服务端发生变化，请重新试算。" }
                check(selectedSourcesMap.values.toList() == selectedSources) { "工资选择已变更，请重新试算。" }
                previewScope = readScope
                previewResult = preview
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: Exception) {
                previewError = e.message ?: "试算方案失败"
            } finally {
                previewing = false
            }
        }
    }

    // 确认并持久化提交：先做所有前置一致性与时区/警告校验，再持久化与发送
    fun submitConfirmation() {
        val preview = previewResult ?: return
        if (confirming || submittedSuccessfully) return
        confirming = true
        confirmError = null

        scope.launch {
            val authScope = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
                confirming = false
                return@launch
            } catch (e: Exception) {
                confirmError = "无法获取认证上下文：${e.message}"
                confirming = false
                return@launch
            }

            // 1. 严格前置校验：试算账号一致性、周期ID匹配、警告冲突拦截（绝不将不合规请求落盘）
            val pScope = previewScope
            if (pScope == null || !authScope.sameIdentity(pScope)) {
                confirmError = "当前登录账号与生成方案试算时的账号不一致，已阻断提交；请重新试算。"
                confirming = false
                return@launch
            }

            if (preview.proposal.periodId != existingPeriodMatching?.id) {
                confirmError = "周期 ID 状态不一致，禁止确认。请重新试算。"
                confirming = false
                return@launch
            }
            if (preview.warnings.any { it.contains("PERIOD_ALREADY_EXISTS") || it.contains("CYCLE_COLLISION") }) {
                confirmError = "检测到周期冲突警告，禁止确认提交。请重新试算。"
                confirming = false
                return@launch
            }

            var pending = activePendingConfirm
            var pendingScope = activePendingConfirmScope
            if (pending == null) {
                val operationId = UUID.randomUUID().toString()
                val request = FinancialPeriodConfirmRequest(
                    operationId = operationId,
                    proposal = preview.proposal,
                    previewToken = preview.previewToken,
                )
                pending = PendingFinancialOperation(
                    operationId = operationId,
                    method = "POST",
                    path = "/api/v1/financial-planning/periods/confirm",
                    payloadJson = request.toJson().toString(),
                    expectedRevision = preview.proposal.expectedRevision,
                )
                try {
                    val unresolved = replayStore.list(authScope.serverBaseUrl, authScope.storageIdentity).any { op ->
                        op.path == "/api/v1/financial-planning/periods/confirm" ||
                            (op.path.startsWith("/api/v1/financial-planning/periods/") && op.path.endsWith("/reconcile"))
                    }
                    check(!unresolved) { "发现尚未核对的周期操作，请关闭并重新进入以核对原请求。" }
                    replayStore.record(authScope.serverBaseUrl, authScope.storageIdentity, pending)
                    activePendingConfirm = pending
                    activePendingConfirmScope = authScope
                    pendingScope = authScope
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    confirmError = "持久化未决操作失败，已阻止请求以防幂等丢失：${e.message}"
                    confirming = false
                    return@launch
                }
            }

            // 发送前严格再次校验 scope 与原始持久化 scope 一致
            val currentScope = try {
                FinancialPrefs.resolveAuthenticatedScope(api)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
                confirming = false
                return@launch
            } catch (e: Exception) {
                confirmError = "重新校验认证上下文失败：${e.message}"
                confirming = false
                return@launch
            }

            val targetScope = pendingScope ?: authScope
            if (!currentScope.sameIdentity(targetScope)) {
                confirmError = "登录账户或服务端地址发生变化，与待执行操作所属账户不一致，已阻止发送；请切回原登录账户。"
                confirming = false
                return@launch
            }

            try {
                repo.replayOperation(
                    pending.method,
                    pending.path,
                    JSONObject(pending.payloadJson),
                )

                // Server confirmed; prevent a second operation even if local cleanup fails.
                submittedSuccessfully = true
                // 提交成功，尝试清理本地持久化记录
                var cleanupError: String? = null
                try {
                    replayStore.remove(targetScope.serverBaseUrl, targetScope.storageIdentity, pending.operationId)
                } catch (ce: CancellationException) {
                    throw ce
                } catch (e: Exception) {
                    cleanupError = "已成功在服务端提交方案，但清理本地未决记录失败：${e.message}。周期已生效，请知悉。"
                }

                activePendingConfirm = null
                activePendingConfirmScope = null

                if (cleanupError != null) {
                    // 若本地清理遇到异常，留在当前弹窗提示用户，避免静默关闭误以为未处理
                    confirmError = cleanupError
                    onSaved()
                } else {
                    onSaved()
                    onClose()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: Exception) {
                when (val failure = classifyFinancialWriteFailure(e)) {
                    is FinancialWriteFailure.Rejected -> {
                        // 4xx 确切拒绝，仅当 scope 严格一致时清理对应未决
                        val scopeCheck = try {
                            FinancialPrefs.resolveAuthenticatedScope(api)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            null
                        }
                        if (scopeCheck != null && scopeCheck.sameIdentity(targetScope)) {
                            try {
                                replayStore.remove(targetScope.serverBaseUrl, targetScope.storageIdentity, pending.operationId)
                            } catch (ce: CancellationException) {
                                throw ce
                            } catch (_: Exception) {}
                        }
                        activePendingConfirm = null
                        activePendingConfirmScope = null
                        confirmError = failure.message
                    }
                    is FinancialWriteFailure.Unknown -> {
                        // 未知网络超时或 5xx，保留同一 pending，下次重试同一请求
                        confirmError = "提交结果暂时未知：${failure.message}。操作已安全记录在本地，点击「确认」将重试同一请求，不会创建重复周期。"
                    }
                    FinancialWriteFailure.AuthExpired -> onAuthExpired()
                }
            } finally {
                confirming = false
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = {
            if (!confirming && !replayingPending && !previewing && !initialLoading) onClose()
        },
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // 顶栏标题与关闭按钮
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = "从已有工资开启四用途",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = tokens.fg,
                    )
                    Text(
                        text = "选择已记录的发薪来源，将其纳入四用途执行计划",
                        style = MaterialTheme.typography.bodySmall,
                        color = tokens.muted,
                    )
                }
                IconButton(
                    onClick = onClose,
                    enabled = !confirming && !replayingPending && !previewing && !initialLoading,
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭", tint = tokens.fg)
                }
            }

            if (initialLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(200.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
                return@ModalBottomSheet
            }

            if (unsupported) {
                Surface(
                    color = tokens.warning.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = "当前服务端未接入四用途执行能力",
                            fontWeight = FontWeight.Bold,
                            color = tokens.warning,
                        )
                        Text(
                            text = "服务端暂未支持 /api/v1/financial-planning 规划周期接口，无法开启四用途执行。",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.fg,
                        )
                    }
                }
                return@ModalBottomSheet
            }

            if (initialError != null) {
                Surface(
                    color = tokens.danger.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = "加载失败: $initialError",
                            fontWeight = FontWeight.Bold,
                            color = tokens.danger,
                        )
                        OutlinedButton(
                            onClick = { scanAndInit() },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text("重试")
                        }
                    }
                }
                return@ModalBottomSheet
            }

            // 1. 存在未决待重放请求时 (Fail-closed)
            if (pendingOperationToResolve != null || resolvingPendingMessage != null) {
                Surface(
                    color = tokens.warning.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.Filled.Warning, contentDescription = null, tint = tokens.warning)
                            Text(
                                text = "存在未完成的理财周期操作",
                                fontWeight = FontWeight.Bold,
                                color = tokens.warning,
                            )
                        }
                        resolvingPendingMessage?.let {
                            Text(text = it, style = MaterialTheme.typography.bodySmall, color = tokens.fg)
                        }
                        OutlinedButton(
                            onClick = { scanAndInit() },
                            enabled = !replayingPending,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text("重新核对并加载") }
                        if (pendingOperationToResolve != null) {
                            Button(
                                onClick = ::replayPendingOperation,
                                enabled = !replayingPending,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 48.dp),
                            ) {
                                if (replayingPending) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        color = Color.White,
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text("正在重放...")
                                } else {
                                    Text("重放原请求 (单号: ${pendingOperationToResolve!!.operationId.take(8)}...)")
                                }
                            }
                        }
                    }
                }
                return@ModalBottomSheet
            }

            val cfg = configResponse
            // 2. 规划配置未开启时，明确说明并提供直接设置按钮（不静默开启）
            if (cfg != null && !cfg.config.enabled) {
                Surface(
                    color = tokens.muted.copy(alpha = 0.08f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.Filled.Info, contentDescription = null, tint = tokens.muted)
                            Text(
                                text = "四用途理财规划未启用",
                                fontWeight = FontWeight.Bold,
                                color = tokens.fg,
                            )
                        }
                        Text(
                            text = "当前四用途规划功能处于停用状态。在将工资纳入执行周期前，需要先在规划设置中开启规划功能，并确认四用途比例与必要开支基准（系统不会静默开启）。",
                            style = MaterialTheme.typography.bodySmall,
                            color = tokens.muted,
                        )
                        Button(
                            onClick = {
                                onClose()
                                onOpenConfig()
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp),
                        ) {
                            Text("前往规划设置")
                        }
                    }
                }
                return@ModalBottomSheet
            }

            // 3. 试算预览界面
            if (previewResult != null) {
                val preview = previewResult!!
                val isExisting = preview.proposal.periodId != null
                val timeZone = preview.window.timeZone

                Surface(
                    color = tokens.bg,
                    shape = RoundedCornerShape(12.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, tokens.muted.copy(alpha = 0.2f)),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = if (isExisting) "方案预览（追加至已有周期）" else "方案预览（创建新周期）",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            color = tokens.fg,
                        )
                        Text(
                            text = "周期时间：${formatEpochDateInZone(preview.window.start, timeZone)} 至 ${formatEpochDateInZone(preview.window.end, timeZone)} (含起不含止 · $timeZone)",
                            fontSize = 12.sp,
                            color = tokens.muted,
                        )
                        Text(
                            text = "计划总收入：¥${formatYuan(preview.decision.incomeCents)}",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = tokens.accent,
                        )

                        HorizontalDivider(color = tokens.muted.copy(alpha = 0.15f))

                        // 精确展示 4 项指标
                        Text(text = "四用途执行目标划分：", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)

                        // 1. 必要开支 50%
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text("1. 必要开支 (${FinancialHistoryLabels.formatBpsPercent(preview.decision.ratiosBps.essentials)})", fontSize = 12.sp, color = tokens.fg)
                            Text("¥${formatYuan(preview.decision.targets.essentials)}", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        }

                        // 2. 随心消费 10%
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text("2. 随心消费 (${FinancialHistoryLabels.formatBpsPercent(preview.decision.ratiosBps.joy)})", fontSize = 12.sp, color = tokens.fg)
                            Text("¥${formatYuan(preview.decision.targets.joy)}", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        }

                        // 3. 成长积累 25% (未接入真实划拨)
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column {
                                Text("3. 成长积累 (${FinancialHistoryLabels.formatBpsPercent(preview.decision.ratiosBps.growth)})", fontSize = 12.sp, color = tokens.fg)
                                Text("未接入实际划拨", fontSize = 10.sp, color = tokens.muted)
                            }
                            Text("¥${formatYuan(preview.decision.targets.growth)}", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        }

                        // 4. 应急储备 15% (未接入真实划拨)
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column {
                                Text("4. 应急储备 (${FinancialHistoryLabels.formatBpsPercent(preview.decision.ratiosBps.reserve)})", fontSize = 12.sp, color = tokens.fg)
                                Text("未接入实际划拨", fontSize = 10.sp, color = tokens.muted)
                            }
                            Text("¥${formatYuan(preview.decision.targets.reserve)}", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        }

                        // 时区不一致告警
                        if (existingPeriodMatching != null && existingPeriodMatching!!.window.timeZone != cfg?.config?.timeZone) {
                            Text(
                                text = "提示：已有周期冻结时区 (${existingPeriodMatching!!.window.timeZone}) 与当前规划时区 (${cfg?.config?.timeZone}) 不同，将严格沿用已有周期的时区设置。",
                                fontSize = 11.sp,
                                color = tokens.warning,
                            )
                        }

                        // 服务端 warnings
                        preview.warnings.forEach { w ->
                            Text(text = "服务端提示：$w", fontSize = 11.sp, color = tokens.warning)
                        }

                        if (isExisting) {
                            Text(
                                text = "已有周期包含 ${preview.sources.size - preview.impact.addedSalaryIds.size} 笔历史有效工资，本次将追加 ${preview.impact.addedSalaryIds.size} 笔工资。",
                                fontSize = 11.sp,
                                color = tokens.muted,
                            )
                        }

                        confirmError?.let {
                            Text(text = it, fontSize = 12.sp, color = tokens.danger)
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            OutlinedButton(
                                onClick = {
                                    previewResult = null
                                    confirmError = null
                                },
                                enabled = !confirming && activePendingConfirm == null && !submittedSuccessfully,
                                modifier = Modifier
                                    .weight(1f)
                                    .heightIn(min = 48.dp),
                            ) {
                                Text("返回重选")
                            }

                            Button(
                                onClick = ::submitConfirmation,
                                enabled = !confirming && !submittedSuccessfully,
                                modifier = Modifier
                                    .weight(1f)
                                    .heightIn(min = 48.dp),
                            ) {
                                if (confirming) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        color = Color.White,
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text("提交中...")
                                } else {
                                    Text(if (isExisting) "确认追加更新" else "确认创建")
                                }
                            }
                        }
                    }
                }
                return@ModalBottomSheet
            }

            // 4. 工资列表展示与多选
            val currentSelectedMonth = selectedSourcesMap.values.firstOrNull()?.proposedGroupMonth

            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "选择发薪记录 (已选 ${selectedSourcesMap.size} 笔)",
                        fontWeight = FontWeight.SemiBold,
                        color = tokens.fg,
                    )
                    if (currentSelectedMonth != null) {
                        Text(
                            text = "锁定归属月: $currentSelectedMonth",
                            fontSize = 12.sp,
                            color = tokens.accent,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }

                if (salaryListLoading) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(120.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp))
                    }
                } else if (salaryListError != null) {
                    Text(salaryListError!!, color = tokens.danger, fontSize = 12.sp)
                } else if (salaryItems.isEmpty()) {
                    Text(
                        text = "暂无工资记录。请先在记账中记录工资。",
                        style = MaterialTheme.typography.bodySmall,
                        color = tokens.muted,
                    )
                } else {
                    salaryItems.forEach { source ->
                        val isChecked = source.salaryId in selectedSourcesMap
                        val isSameMonth = currentSelectedMonth == null || source.proposedGroupMonth == currentSelectedMonth
                        val canSelect = source.selectable && source.includedPeriodId == null && isSameMonth && !previewing
                        val accountName = accountNames[source.accountId] ?: "账户: ${source.accountId.take(6)}..."

                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = if (isChecked) tokens.accent.copy(alpha = 0.08f) else tokens.bg,
                            border = androidx.compose.foundation.BorderStroke(
                                1.dp,
                                if (isChecked) tokens.accent else tokens.muted.copy(alpha = 0.15f),
                            ),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = canSelect) {
                                    selectedSourcesMap = if (isChecked) {
                                        selectedSourcesMap - source.salaryId
                                    } else {
                                        selectedSourcesMap + (source.salaryId to source)
                                    }
                                },
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(12.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Checkbox(
                                        checked = isChecked,
                                        onCheckedChange = { checked ->
                                            selectedSourcesMap = if (checked) {
                                                selectedSourcesMap + (source.salaryId to source)
                                            } else {
                                                selectedSourcesMap - source.salaryId
                                            }
                                        },
                                        enabled = canSelect,
                                    )
                                    Column {
                                        Row(
                                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Text(
                                                text = "¥${formatYuan(source.amountCents)}",
                                                fontWeight = FontWeight.Bold,
                                                fontSize = 14.sp,
                                                color = tokens.fg,
                                            )
                                            Text(
                                                text = source.proposedGroupMonth,
                                                fontSize = 11.sp,
                                                color = tokens.muted,
                                            )
                                        }
                                        Row(
                                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Text(
                                                text = formatEpochDateInZone(source.date, cfg?.config?.timeZone),
                                                fontSize = 11.sp,
                                                color = tokens.muted,
                                            )
                                            Text(
                                                text = "· $accountName",
                                                fontSize = 11.sp,
                                                color = tokens.muted,
                                            )
                                        }
                                        if (source.includedPeriodId != null) {
                                            Text(
                                                text = "已纳入周期: ${source.includedPeriodId} (r${source.includedRevision ?: 0})",
                                                fontSize = 10.sp,
                                                color = tokens.muted,
                                            )
                                        } else if (!source.selectable) {
                                            Text(
                                                text = "不可选: ${source.reason ?: "原因未知"}",
                                                fontSize = 10.sp,
                                                color = tokens.danger,
                                            )
                                        } else if (!isSameMonth) {
                                            Text(
                                                text = "仅可勾选同一归属月份",
                                                fontSize = 10.sp,
                                                color = tokens.warning,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // 分页控制栏（服务端真实分页，非静默截断）
                    val totalPages = if (salaryTotal > 0) ((salaryTotal + pageSize - 1) / pageSize).toInt() else 1
                    val currentPage = (salaryOffset / pageSize) + 1
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OutlinedButton(
                            onClick = { loadSalaryPage(salaryOffset - pageSize) },
                            enabled = salaryOffset > 0 && !salaryListLoading && !previewing,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text("上一页", fontSize = 12.sp)
                        }

                        Text(
                            text = "第 $currentPage / $totalPages 页 (共 $salaryTotal 笔)",
                            fontSize = 11.sp,
                            color = tokens.muted,
                        )

                        OutlinedButton(
                            onClick = { loadSalaryPage(salaryOffset + pageSize) },
                            enabled = salaryOffset + pageSize < salaryTotal && !salaryListLoading && !previewing,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text("下一页", fontSize = 12.sp)
                        }
                    }
                }

                existingPeriodAmbiguityError?.let {
                    Text(text = it, color = tokens.danger, fontSize = 12.sp)
                }

                previewError?.let {
                    Text(text = it, color = tokens.danger, fontSize = 12.sp)
                }

                Button(
                    onClick = ::executePreview,
                    enabled = selectedSourcesMap.isNotEmpty() && !previewing && !salaryListLoading,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
                ) {
                    if (previewing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = Color.White,
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("正在生成四项指标试算...")
                    } else {
                        Text("试算方案 (${selectedSourcesMap.size} 笔发薪)")
                    }
                }
            }
        }
    }
}
