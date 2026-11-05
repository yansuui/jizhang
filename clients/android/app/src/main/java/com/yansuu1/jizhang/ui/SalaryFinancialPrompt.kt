package com.yansuu1.jizhang.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialConfigResponse
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.FinancialExecutionUnsupportedException
import com.yansuu1.jizhang.repo.FinancialMappingPolicy
import com.yansuu1.jizhang.repo.FinancialPeriod
import com.yansuu1.jizhang.repo.FinancialPeriodConfirmRequest
import com.yansuu1.jizhang.repo.FinancialPeriodProposal
import com.yansuu1.jizhang.repo.FinancialPeriodReason
import com.yansuu1.jizhang.repo.FinancialPreview
import com.yansuu1.jizhang.repo.FinancialSalarySource
import com.yansuu1.jizhang.repo.FinancialSourceSelection
import com.yansuu1.jizhang.repo.FinancialSourceStatus
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Builds the explicit salary-confirmation proposal offered after a salary POST.
 * Pure so the "complete existing sources" rule is covered without Compose.
 */
object SalaryFinancialProposalBuilder {

    /**
     * @return the proposal to preview, or null when no period should be offered
     *   (config disabled, source not selectable, ambiguous existing period).
     */
    fun build(
        config: FinancialConfigResponse,
        source: FinancialSalarySource,
        periods: List<FinancialPeriod>,
    ): FinancialPeriodProposal? {
        if (!config.config.enabled) return null
        if (!source.selectable) return null
        // Already owned by a confirmed/reconciled period: no new decision.
        if (source.includedPeriodId != null) return null
        val matching = periods.filter { it.window.groupMonth == source.proposedGroupMonth }
        // Never guess which existing period to revise when data is inconsistent.
        if (matching.size > 1) return null
        val existing = matching.singleOrNull()

        val selected = linkedMapOf<String, FinancialSourceSelection>()
        if (existing != null) {
            // Salary confirmation keeps every existing valid source; only the
            // new salary is an explicit addition. Removed/deleted/group-moved
            // sources cannot be retained and are left to server reconciliation.
            existing.sources
                .filter { it.status == FinancialSourceStatus.VALID }
                .forEach { snapshot ->
                    selected[snapshot.salaryId] = FinancialSourceSelection(
                        salaryId = snapshot.salaryId,
                        expectedSourceToken = snapshot.sourceToken,
                    )
                }
        }
        selected[source.salaryId] = FinancialSourceSelection(
            salaryId = source.salaryId,
            expectedSourceToken = source.sourceToken,
        )
        require(selected.size <= 200) { "理财周期来源超过 200 笔，无法自动预览。" }
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
 * Optional post-salary financial-period preview/confirm.
 *
 * Skipping never calls the server and therefore never creates or updates a
 * period. A failed/unsupported preview is independent from the already
 * committed salary write; this composable never reports the salary as failed.
 */
@Composable
fun SalaryFinancialPrompt(
    api: ApiClient,
    salaryId: String,
    onAuthExpired: () -> Unit,
    onMessage: (String) -> Unit,
    onPlanConfirmed: () -> Unit = {},
    onFinished: () -> Unit,
) {
    val repo = remember(api) { FinancialExecutionRepository(api) }
    val context = LocalContext.current
    val store = remember(context) { OperationReplayStore(context) }
    val scope = rememberCoroutineScope()
    var preview by remember(salaryId) { mutableStateOf<FinancialPreview?>(null) }
    var loadError by remember(salaryId) { mutableStateOf<String?>(null) }
    var loading by remember(salaryId) { mutableStateOf(true) }
    var confirming by remember(salaryId) { mutableStateOf(false) }
    var confirmError by remember(salaryId) { mutableStateOf<String?>(null) }
    var pendingConfirm by remember(salaryId) { mutableStateOf<PendingFinancialOperation?>(null) }

    LaunchedEffect(api, salaryId) {
        loading = true
        loadError = null
        try {
            val capabilities = repo.getCapabilities()
            if (!capabilities.executionSupported) {
                onFinished()
                return@LaunchedEffect
            }
            val config = repo.getConfig()
            if (!config.config.enabled) {
                onFinished()
                return@LaunchedEffect
            }
            val source = repo.getSalarySource(salaryId).source
            val periods = repo.getPeriods(limit = 100, offset = 0).items
            val proposal = SalaryFinancialProposalBuilder.build(config, source, periods)
            if (proposal == null) {
                onFinished()
                return@LaunchedEffect
            }
            preview = repo.previewPeriod(proposal)
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
            onFinished()
        } catch (_: FinancialExecutionUnsupportedException) {
            onFinished()
        } catch (e: Exception) {
            loadError = e.message?.takeIf { it.isNotBlank() } ?: "理财周期预览暂时不可用。"
        } finally {
            loading = false
        }
    }

    if (loading) {
        // Non-blocking: the salary write already succeeded; no modal while loading.
        return
    }

    loadError?.let { message ->
        AlertDialog(
            onDismissRequest = { onFinished() },
            title = { Text("理财周期预览未完成") },
            text = { Text("工资已保存。$message 可稍后到四用途执行页面重试；跳过不会创建周期。") },
            confirmButton = { Button(onClick = { onFinished() }) { Text("知道了") } },
        )
        return
    }

    val current = preview ?: return
    val existing = current.proposal.periodId != null

    fun confirm() {
        if (confirming) return
        confirming = true
        confirmError = null
        scope.launch {
            var scopeInfo: FinancialScope? = null
            var pending = pendingConfirm
            try {
                scopeInfo = FinancialPrefs.resolveFinancialScope(api)
                if (pending == null) {
                    val operationId = UUID.randomUUID().toString()
                    val request = FinancialPeriodConfirmRequest(
                        operationId = operationId,
                        proposal = current.proposal,
                        previewToken = current.previewToken,
                    )
                    pending = financialPendingOperation(
                        operationId = operationId,
                        method = "POST",
                        path = "/api/v1/financial-planning/periods/confirm",
                        payload = request.toJson(),
                    )
                    // Persist before the first send so an unknown result can be
                    // recovered by the workspace's operation scan.
                    store.record(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, pending)
                    pendingConfirm = pending
                }
                repo.replayOperation(
                    pending.method,
                    pending.path,
                    org.json.JSONObject(pending.payloadJson),
                )
                runCatching {
                    store.remove(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, pending.operationId)
                }
                pendingConfirm = null
                onMessage(if (existing) "理财周期已更新。" else "理财周期已创建。")
                onPlanConfirmed()
                onFinished()
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: Exception) {
                when (val failure = classifyFinancialWriteFailure(e)) {
                    is FinancialWriteFailure.Rejected -> {
                        scopeInfo?.let { info ->
                            pending?.let { operation ->
                                runCatching {
                                    store.remove(info.serverBaseUrl, info.storageIdentity, operation.operationId)
                                }
                            }
                        }
                        pendingConfirm = null
                        confirmError = failure.message
                    }
                    is FinancialWriteFailure.Unknown -> {
                        confirmError = if (pendingConfirm != null) {
                            "结果暂时未知：${failure.message} 点击“确认”会重试同一请求。"
                        } else {
                            "未发送确认请求：${failure.message}"
                        }
                    }
                    FinancialWriteFailure.AuthExpired -> onAuthExpired()
                }
            } finally {
                confirming = false
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!confirming) onFinished() },
        title = { Text(if (existing) "更新本次理财周期？" else "创建本次理财周期？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("工资已保存。是否把这次工资纳入理财周期？")
                Text("周期：" + formatFrozenFinancialWindow(current.window.start, current.window.end, current.window.timeZone))
                Text("收入：" + formatYuan(current.decision.incomeCents))
                Text("必要开支：" + formatYuan(current.decision.targets.essentials))
                Text("随心消费：" + formatYuan(current.decision.targets.joy))
                if (existing) {
                    Text("已有周期会保留全部有效工资来源，只追加本次工资。")
                }
                current.warnings.forEach { Text("提示：" + it) }
                confirmError?.let { Text(it) }
            }
        },
        confirmButton = {
            Button(onClick = ::confirm, enabled = !confirming) {
                Text(if (confirming) "提交中…" else if (existing) "确认更新" else "确认创建")
            }
        },
        dismissButton = {
            TextButton(onClick = onFinished, enabled = !confirming) {
                Text("暂不创建")
            }
        },
    )
}
