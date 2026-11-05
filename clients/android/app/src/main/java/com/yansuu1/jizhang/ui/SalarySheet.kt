package com.yansuu1.jizhang.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.BudgetRepository
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.FinancialExecutionUnsupportedException
import com.yansuu1.jizhang.repo.MetaRepository
import java.math.BigDecimal
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private enum class SalaryStage { History, Form, Allocation }
private enum class SalaryFormMode { Create, Edit }

private data class SalaryFormSnapshot(
    val amount: String,
    val date: String,
    val accountId: String,
    val note: String,
    val templateId: String?,
)

/**
 * Salary history, create/edit and allocation editing (S14–S16).
 * Salary and allocation values shown here come from the server. The local
 * allocation sum is only a form check; it is never used as a budget result.
 */
@Composable
fun SalarySheet(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onSaved: () -> Unit,
    onPlanConfirmed: () -> Unit = {},
    onClose: () -> Unit,
    onRepairTemplates: () -> Unit = {},
    /** Caller increments after the template editor closes; the active form draft stays mounted. */
    templateRefreshToken: Int = 0,
    /** Parent overlay temporarily owns Back while template repair is visible. */
    backEnabled: Boolean = true,
) {
    val scope = rememberCoroutineScope()
    val repo = remember(api) { BudgetRepository(api) }
    val meta = remember(api) { MetaRepository(api) }
    val financial = remember(api) { FinancialExecutionRepository(api) }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }
    val salaryReplay = remember(api, context) {
        SalaryReplayCoordinator(
            gateway = object : SalaryMutationGateway {
                override suspend fun sendExact(operation: PendingFinancialOperation): JSONObject =
                    financial.replayOperation(
                        operation.method,
                        operation.path,
                        JSONObject(operation.payloadJson),
                    )

                override suspend fun lookup(operationId: String) =
                    financial.getOperation(operationId)
            },
            store = OperationReplaySalaryStore(replayStore),
            scopeProvider = { FinancialPrefs.resolveFinancialScope(api) },
        )
    }
    val motion = LocalMotionTokens.current

    var stage by rememberSaveable { mutableStateOf(SalaryStage.History) }
    var reloadKey by remember { mutableStateOf(0) }
    var historyLoading by remember { mutableStateOf(true) }
    var historyError by remember { mutableStateOf<String?>(null) }
    var historyFeedback by remember { mutableStateOf<String?>(null) }
    var salaries by remember { mutableStateOf(emptyList<JSONObject>()) }
    var accounts by remember { mutableStateOf(emptyList<JSONObject>()) }
    var templates by remember { mutableStateOf(emptyList<JSONObject>()) }
    var categories by remember { mutableStateOf(emptyList<JSONObject>()) }

    var formMode by remember { mutableStateOf(SalaryFormMode.Create) }
    var selectedSalaryId by remember { mutableStateOf<String?>(null) }
    var formLoading by remember { mutableStateOf(false) }
    var formLoadError by remember { mutableStateOf<String?>(null) }
    var formError by remember { mutableStateOf<String?>(null) }
    var amountError by remember { mutableStateOf<String?>(null) }
    var dateError by remember { mutableStateOf<String?>(null) }
    var allocationFormError by remember { mutableStateOf<String?>(null) }
    var savingSalary by remember { mutableStateOf(false) }
    var salaryIdempotencySupported by remember { mutableStateOf<Boolean?>(null) }
    var pendingSalaryOperation by remember { mutableStateOf<PendingFinancialOperation?>(null) }
    var salaryPendingUnknown by remember { mutableStateOf(false) }
    var showDismissLegacyDialog by remember { mutableStateOf(false) }
    var financialPromptSalaryId by remember { mutableStateOf<String?>(null) }
    var amountText by remember { mutableStateOf("") }
    var dateText by remember { mutableStateOf(todayStr()) }
    var accountId by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var templateId by remember { mutableStateOf<String?>(null) }
    var templateSelectorExpanded by rememberSaveable { mutableStateOf(false) }
    var formDetail by remember { mutableStateOf<JSONObject?>(null) }
    var formAllocations by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var formAllocationBaseline by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var formBaseline by remember { mutableStateOf<SalaryFormSnapshot?>(null) }
    var confirmSalaryAllocationReplacement by remember { mutableStateOf(false) }

    var allocationLoading by remember { mutableStateOf(false) }
    var allocationLoadError by remember { mutableStateOf<String?>(null) }
    var allocationDetail by remember { mutableStateOf<JSONObject?>(null) }
    var allocationAmounts by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var allocationBaseline by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var allocationError by remember { mutableStateOf<String?>(null) }
    var savingAllocation by remember { mutableStateOf(false) }
    var confirmAllocationReplacement by remember { mutableStateOf(false) }

    var deleteTarget by remember { mutableStateOf<JSONObject?>(null) }
    var deletingSalary by remember { mutableStateOf(false) }
    var deleteError by remember { mutableStateOf<String?>(null) }
    var discardStage by remember { mutableStateOf<SalaryStage?>(null) }

    val categoryNames = remember(categories) {
        categories.associate { it.optString("id") to it.optString("name", "未命名分类") }
    }
    val activeCategoryIds = remember(categories) {
        categories.mapNotNull { it.optString("id").takeIf(String::isNotBlank) }.toSet()
    }
    val accountNames = remember(accounts) {
        accounts.associate { it.optString("id") to it.optString("name", "未命名账户") }
    }
    val formSnapshot = SalaryFormSnapshot(amountText, dateText, accountId, note, templateId)
    val formDirty = formBaseline != null &&
        (formSnapshot != formBaseline || formAllocations != formAllocationBaseline)
    val allocationDirty = allocationBaseline.isNotEmpty() && allocationAmounts != allocationBaseline

    LaunchedEffect(api, reloadKey) {
        historyLoading = true
        historyError = null
        try {
            val loadedAccounts = meta.accounts().jsonObjects("items")
            val loadedSalaries = repo.salaries().jsonObjects("items")
            val loadedTemplates = repo.templates().jsonObjects("items")
            val loadedCategories = meta.categories(0).jsonObjects("items")
            accounts = loadedAccounts
            salaries = loadedSalaries
            templates = loadedTemplates
            categories = loadedCategories
            // Capability is independent: an old server or transient failure must
            // not make the salary list unusable. Unknown blocks new writes rather
            // than risking an idempotency key the server cannot understand.
            salaryIdempotencySupported = try {
                financial.getCapabilities().salaryIdempotency
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                throw e
            } catch (_: FinancialExecutionUnsupportedException) {
                false
            } catch (_: Exception) {
                null
            }
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            historyError = e.message?.takeIf(String::isNotBlank) ?: "工资记录加载失败，请重试。"
        } finally {
            historyLoading = false
        }
    }

    LaunchedEffect(api, templateRefreshToken) {
        if (templateRefreshToken == 0) return@LaunchedEffect
        try {
            val refreshedTemplates = repo.templates().jsonObjects("items")
            val refreshedCategories = meta.categories(0).jsonObjects("items")
            templates = refreshedTemplates
            categories = refreshedCategories
            val currentActiveCategoryIds = refreshedCategories.mapNotNull { it.optString("id").takeIf(String::isNotBlank) }.toSet()
            if (stage == SalaryStage.Form && formMode == SalaryFormMode.Create && templateId.isNullOrBlank()) {
                val defaultId = refreshedTemplates.firstOrNull {
                    it.optBoolean("isDefault") && it.isUsableSalaryTemplate(currentActiveCategoryIds)
                }?.optString("id")?.takeIf(String::isNotBlank)
                if (defaultId != null) {
                    templateId = defaultId
                    // The template was repaired outside this form; update only this baseline field.
                    formBaseline = formBaseline?.copy(templateId = defaultId)
                    if (formError?.contains("分配模板") == true) formError = null
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            if (stage == SalaryStage.Form && formMode == SalaryFormMode.Create) {
                formError = e.message?.takeIf(String::isNotBlank) ?: "模板刷新失败，请重试。"
            }
        }
    }

    fun returnToHistory() {
        stage = SalaryStage.History
        formLoading = false
        allocationLoading = false
        confirmAllocationReplacement = false
        confirmSalaryAllocationReplacement = false
    }

    fun restorePendingSalaryForm(operation: PendingFinancialOperation) {
        val payload = try {
            JSONObject(operation.payloadJson)
        } catch (_: Exception) {
            formError = "待重放的工资请求已损坏，请勿新建工资并联系支持。"
            return
        }
        formMode = SalaryFormMode.Create
        selectedSalaryId = null
        formLoading = false
        formLoadError = null
        formError = null
        amountError = null
        dateError = null
        allocationFormError = null
        amountText = payload.optLong("amountCents").takeIf { it > 0L }?.let(::formatYuan).orEmpty()
        dateText = payload.optLong("date").takeIf { it > 0L }?.let(::dateInput) ?: todayStr()
        accountId = payload.optString("accountId")
        note = payload.optString("note")
        templateSelectorExpanded = false
        templateId = payload.optString("templateId").takeIf { it.isNotBlank() }
        formDetail = null
        formAllocations = emptyMap()
        formAllocationBaseline = emptyMap()
        formBaseline = SalaryFormSnapshot(amountText, dateText, accountId, note, templateId)
        pendingSalaryOperation = operation
        salaryPendingUnknown = true
        if (!isSafelyKeyedSalaryOperation(operation)) {
            formError = "旧工资请求结果待核对：此记录缺少唯一 operationId，不能自动重试以防重复入账。请查看工资历史；若确认已入账或不再入账，可显式结束此记录（该动作不新增或撤销任何工资）。"
        }
        stage = SalaryStage.Form
    }

    LaunchedEffect(api) {
        try {
            val report = salaryReplay.recover()
            if (report.recovered.isNotEmpty()) {
                historyFeedback = "上次未确认的工资保存已由服务器确认。"
                try {
                    salaries = repo.salaries().jsonObjects("items")
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // The write is committed; only the refresh failed.
                    historyError = "工资保存已确认，但列表刷新失败：" + (e.message ?: "请手动重试。")
                }
                report.recovered.lastOrNull()?.optString("id")
                    ?.takeIf(String::isNotBlank)?.let { financialPromptSalaryId = it }
            }
            if (report.failures.isNotEmpty()) {
                historyFeedback = report.failures.joinToString("；")
            }
            report.unresolved.firstOrNull()?.let { operation ->
                restorePendingSalaryForm(operation)
                if (report.legacyUnkeyed.any { it.operationId == operation.operationId }) {
                    historyFeedback = "旧工资请求结果待核对，已恢复原请求草稿；请核对历史工资后显式结束或重试。"
                } else {
                    historyFeedback = "有一笔工资保存结果尚待确认，已恢复原请求；请核对后重试。"
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            historyFeedback = "待核对工资恢复失败：" + (e.message ?: "稍后可重试。")
        }
    }

    fun requestBack() {
        when (stage) {
            SalaryStage.History -> onClose()
            SalaryStage.Form -> if (formDirty) discardStage = SalaryStage.Form else returnToHistory()
            SalaryStage.Allocation -> if (allocationDirty) discardStage = SalaryStage.Allocation else returnToHistory()
        }
    }

    BackHandler(enabled = backEnabled && (stage != SalaryStage.History || discardStage != null)) {
        if (discardStage != null) discardStage = null else requestBack()
    }

    fun openCreateForm() {
        if (pendingSalaryOperation != null) {
            restorePendingSalaryForm(pendingSalaryOperation!!)
            historyFeedback = "请先处理上次结果未确认的工资保存。"
            return
        }
        formMode = SalaryFormMode.Create
        selectedSalaryId = null
        formLoading = false
        formLoadError = null
        formError = null
        amountError = null
        dateError = null
        allocationFormError = null
        amountText = ""
        dateText = todayStr()
        accountId = ""
        note = ""
        templateSelectorExpanded = false
        templateId = templates.firstOrNull {
            it.optBoolean("isDefault") && it.isUsableSalaryTemplate(activeCategoryIds)
        }?.optString("id")
        formDetail = null
        formAllocations = emptyMap()
        formAllocationBaseline = emptyMap()
        formBaseline = SalaryFormSnapshot(amountText, dateText, accountId, note, templateId)
        stage = SalaryStage.Form
    }

    fun openEditForm(salary: JSONObject) {
        val id = salary.optString("id").takeIf(String::isNotBlank) ?: return
        selectedSalaryId = id
        formMode = SalaryFormMode.Edit
        formLoading = true
        formLoadError = null
        formError = null
        amountError = null
        dateError = null
        allocationFormError = null
        amountText = formatYuan(salary.optLong("amountCents"))
        dateText = dateInput(salary.optLong("date"))
        accountId = salary.optString("accountId")
        note = salary.optString("note")
        templateSelectorExpanded = false
        templateId = null
        formDetail = null
        formAllocations = emptyMap()
        formAllocationBaseline = emptyMap()
        formBaseline = null
        stage = SalaryStage.Form
        scope.launch {
            try {
                val detail = repo.salary(id)
                if (stage != SalaryStage.Form || formMode != SalaryFormMode.Edit || selectedSalaryId != id) return@launch
                val initial = allocationMapFrom(detail, categoryNames)
                formDetail = detail
                formAllocations = initial
                formAllocationBaseline = initial
                formBaseline = SalaryFormSnapshot(amountText, dateText, accountId, note, templateId)
                formLoading = false
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (selectedSalaryId == id && stage == SalaryStage.Form) {
                    formLoadError = e.message?.takeIf(String::isNotBlank) ?: "工资详情加载失败，请重试。"
                    formLoading = false
                }
            }
        }
    }

    fun openAllocationEditor(id: String) {
        selectedSalaryId = id
        allocationDetail = null
        allocationAmounts = emptyMap()
        allocationBaseline = emptyMap()
        allocationLoading = true
        allocationLoadError = null
        allocationError = null
        stage = SalaryStage.Allocation
        scope.launch {
            try {
                val detail = repo.salary(id)
                if (stage != SalaryStage.Allocation || selectedSalaryId != id) return@launch
                val initial = allocationMapFrom(detail, categoryNames)
                allocationDetail = detail
                allocationAmounts = initial
                allocationBaseline = initial
                allocationLoading = false
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (stage == SalaryStage.Allocation && selectedSalaryId == id) {
                    allocationLoadError = e.message?.takeIf(String::isNotBlank) ?: "工资分配加载失败，请重试。"
                    allocationLoading = false
                }
            }
        }
    }

    fun refreshSalaryHistory(message: String) {
        historyFeedback = message
        historyError = null
        scope.launch {
            try {
                salaries = repo.salaries().jsonObjects("items")
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                historyError = "操作已由服务器确认，但工资列表未能刷新：" + (e.message ?: "请重试。")
            }
        }
    }

    fun applySalaryOutcome(outcome: SalaryMutationOutcome, request: SalaryCreateRequest? = null) {
        when (outcome) {
            is SalaryMutationOutcome.Success -> {
                pendingSalaryOperation = null
                salaryPendingUnknown = false
                selectedSalaryId = outcome.salary.optString("id").takeIf(String::isNotBlank)
                    ?: selectedSalaryId
                returnToHistory()
                refreshSalaryHistory("工资已保存，列表与预算将按服务器结果更新。")
                onSaved()
                outcome.salary.optString("id").takeIf(String::isNotBlank)?.let {
                    financialPromptSalaryId = it
                }
            }
            is SalaryMutationOutcome.DefinitiveFailure -> {
                pendingSalaryOperation = null
                salaryPendingUnknown = false
                formError = outcome.message
            }
            is SalaryMutationOutcome.Unknown -> {
                if (request != null) {
                    pendingSalaryOperation = PendingFinancialOperation(
                        operationId = request.operationId,
                        method = SalaryCreateRequest.METHOD,
                        path = SalaryCreateRequest.PATH,
                        payloadJson = request.payloadJson,
                    )
                }
                salaryPendingUnknown = true
                formError = outcome.message + " 已保留原请求；点击“重试确认”会用同一 operationId 重新发送。"
            }
        }
    }

    fun submitSalary() {
        scope.launch {
            // A pending create is never rebuilt from the form: exact replay with
            // the original operationId is the only safe retry after an unknown
            // result (or process restart).
            pendingSalaryOperation?.let { pending ->
                if (!isSafelyKeyedSalaryOperation(pending)) {
                    salaryPendingUnknown = true
                    formError = "历史工资请求缺少一致的 operationId，已阻止自动重发以防重复；请核对历史工资后显式结束此记录。"
                    return@launch
                }
                savingSalary = true
                formError = null
                try {
                    applySalaryOutcome(salaryReplay.retry(pending))
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    salaryPendingUnknown = true
                    formError = e.message?.takeIf(String::isNotBlank)
                        ?: "工资保存结果仍未知，请稍后重试确认同一请求。"
                } finally {
                    savingSalary = false
                }
                return@launch
            }

            formError = null
            amountError = null
            dateError = null
            allocationFormError = null
            val cents = parseSalaryCents(amountText)
            if (cents == null || cents <= 0L) {
                amountError = "请输入大于 0、最多两位小数的金额。"
                return@launch
            }
            val date = try {
                parseDateInput(dateText)
            } catch (e: Exception) {
                dateError = e.message ?: "请填写有效日期。"
                return@launch
            }
            if (accountId.isBlank()) {
                formError = "请选择到账账户。"
                return@launch
            }
            val usableTemplates = templates.filter { it.isUsableSalaryTemplate(activeCategoryIds) }
            if (formMode == SalaryFormMode.Create && usableTemplates.none { it.optBoolean("isDefault") }) {
                formError = "当前没有可用的默认分配模板，请先修复模板后再记录工资。"
                return@launch
            }
            if (formMode == SalaryFormMode.Create &&
                (templateId.isNullOrBlank() || usableTemplates.none { it.optString("id") == templateId })
            ) {
                formError = "请选择可用的工资分配模板。"
                return@launch
            }

            val currentDetail = formDetail
            val currentServerAmount = currentDetail?.optLong("amountCents")
            val amountChanged = currentServerAmount != null && currentServerAmount != cents
            val allocationsChanged = formAllocations != formAllocationBaseline
            val replaceAllocations = formMode == SalaryFormMode.Edit && (amountChanged || allocationsChanged)
            val allocationPayload: List<Map<String, Any?>>? = if (replaceAllocations) {
                val total = allocationTotalCents(formAllocations)
                if (total == null) {
                    allocationFormError = "请检查分配金额，金额须为非负且最多两位小数。"
                    return@launch
                }
                if (total != cents) {
                    allocationFormError = allocationDifferenceMessage(total, cents)
                    return@launch
                }
                formAllocations.mapNotNull { (id, value) ->
                    val amount = parseNonNegativeCents(value) ?: return@mapNotNull null
                    if (amount == 0L) null else mapOf("categoryId" to id, "amountCents" to amount)
                }.also { if (it.isEmpty()) allocationFormError = "分配金额不能为空。" }
            } else null
            if (allocationFormError != null) return@launch

            savingSalary = true
            try {
                val input = mutableMapOf<String, Any?>(
                    "amountCents" to cents,
                    "date" to date,
                    "accountId" to accountId,
                    "note" to note,
                )
                if (formMode == SalaryFormMode.Create) {
                    templateId?.let { input["templateId"] = it }
                } else if (replaceAllocations) {
                    input["allocations"] = allocationPayload
                }
                if (formMode == SalaryFormMode.Create) {
                    var idempotency = salaryIdempotencySupported
                    if (idempotency == null) {
                        idempotency = try {
                            financial.getCapabilities().salaryIdempotency
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: AuthExpiredException) {
                            throw e
                        } catch (_: FinancialExecutionUnsupportedException) {
                            false
                        } catch (e: Exception) {
                            formError = "暂时无法确认服务器是否支持安全重放，已阻止创建工资以防重复：" +
                                (e.message ?: "请稍后重试。")
                            return@launch
                        }
                        salaryIdempotencySupported = idempotency
                    }
                    val capabilityError = salaryCreateCapabilityError(idempotency)
                    if (capabilityError != null) {
                        formError = capabilityError
                        return@launch
                    }
                    val request = SalaryCreateRequest.build(input, UUID.randomUUID().toString())
                    applySalaryOutcome(salaryReplay.create(request), request)
                } else {
                    val id = selectedSalaryId ?: error("工资记录已失效，请返回列表后重试。")
                    val saved = repo.updateSalary(id, input)
                    selectedSalaryId = saved.optString("id").takeIf(String::isNotBlank) ?: selectedSalaryId
                    returnToHistory()
                    refreshSalaryHistory("工资已保存，列表与预算将按服务器结果更新。")
                    onSaved()
                }
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val isTemplateOrCategoryRejection = e is com.yansuu1.jizhang.net.ApiException && e.status == 400 && (
                    e.message?.contains("category", ignoreCase = true) == true ||
                    e.message?.contains("template", ignoreCase = true) == true ||
                    e.message?.contains("分类", ignoreCase = true) == true ||
                    e.message?.contains("模板", ignoreCase = true) == true
                )
                if (isTemplateOrCategoryRejection) {
                    try {
                        val refreshedTemplates = repo.templates().jsonObjects("items")
                        val refreshedCategories = meta.categories(0).jsonObjects("items")
                        templates = refreshedTemplates
                        categories = refreshedCategories
                        val currentActiveCategoryIds = refreshedCategories.mapNotNull { it.optString("id").takeIf(String::isNotBlank) }.toSet()
                        val usable = refreshedTemplates.filter { it.isUsableSalaryTemplate(currentActiveCategoryIds) }
                        if (usable.none { it.optBoolean("isDefault") }) {
                            formError = "默认工资分配模板包含不可用分类，请先修复模板后再保存。"
                        } else if (templateId != null && usable.none { it.optString("id") == templateId }) {
                            formError = "所选工资分配模板包含不可用分类，请更换或修复模板。"
                        } else {
                            formError = e.message?.takeIf(String::isNotBlank) ?: "工资分配模板已拒绝，请核对模板配置。"
                        }
                    } catch (_: Exception) {
                        formError = e.message?.takeIf(String::isNotBlank) ?: "工资分配模板包含不可用分类，请检查模板。"
                    }
                } else {
                    formError = e.message?.takeIf(String::isNotBlank) ?: "工资保存失败，请核对后重试。"
                }
            } finally {
                savingSalary = false
            }
        }
    }

    fun submitAllocationReplacement() {
        scope.launch {
            val detail = allocationDetail ?: return@launch
            val id = selectedSalaryId ?: return@launch
            allocationError = null
            val total = allocationTotalCents(allocationAmounts)
            if (total == null) {
                allocationError = "请检查分配金额，金额须为非负且最多两位小数。"
                return@launch
            }
            val salaryAmount = detail.optLong("amountCents")
            if (total != salaryAmount) {
                allocationError = allocationDifferenceMessage(total, salaryAmount)
                return@launch
            }
            val payload = allocationAmounts.mapNotNull { (categoryId, value) ->
                val amount = parseNonNegativeCents(value) ?: return@mapNotNull null
                if (amount == 0L) null
                else JSONObject().put("categoryId", categoryId).put("amountCents", amount)
            }
            if (payload.isEmpty()) {
                allocationError = "分配金额不能为空。"
                return@launch
            }
            savingAllocation = true
            try {
                repo.replaceAllocations(id, JSONArray(payload))
                returnToHistory()
                refreshSalaryHistory("工资分配已替换，显示值以服务端刷新结果为准。")
                onSaved()
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                allocationError = e.message?.takeIf(String::isNotBlank) ?: "分配替换失败，输入已保留。"
            } finally {
                savingAllocation = false
            }
        }
    }

    fun confirmDelete() {
        val target = deleteTarget ?: return
        val id = target.optString("id").takeIf(String::isNotBlank) ?: return
        scope.launch {
            deletingSalary = true
            deleteError = null
            try {
                repo.removeSalary(id)
                deleteTarget = null
                refreshSalaryHistory("工资记录及其分配已由服务器删除。")
                onSaved()
            } catch (e: AuthExpiredException) {
                onAuthExpired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                deleteError = e.message?.takeIf(String::isNotBlank) ?: "删除失败，工资记录仍保留。"
            } finally {
                deletingSalary = false
            }
        }
    }

    fun retryFormDetail() {
        val id = selectedSalaryId ?: return
        val row = salaries.firstOrNull { it.optString("id") == id } ?: return
        openEditForm(row)
    }

    fun retryAllocationDetail() {
        val id = selectedSalaryId ?: return
        openAllocationEditor(id)
    }

    val formAmountCents = parseSalaryCents(amountText)
    val serverSalaryAmount = formDetail?.optLong("amountCents")
    val formAmountChanged = serverSalaryAmount != null && formAmountCents != serverSalaryAmount
    val showFormAllocationEditor = formMode == SalaryFormMode.Edit &&
        formDetail != null &&
        (formAmountChanged || formAllocations != formAllocationBaseline)
    val allocationSumInForm = if (showFormAllocationEditor) allocationTotalCents(formAllocations) else null
    val historyRefreshing = historyLoading && salaries.isNotEmpty()

    AnimatedContent(
        targetState = stage,
        modifier = Modifier.fillMaxSize(),
        transitionSpec = {
            val direction = if (targetState == SalaryStage.History) -1 else 1
            val duration = motion.baseMillis
            (
                slideInHorizontally(
                    animationSpec = tween(durationMillis = duration),
                    initialOffsetX = { width -> direction * width / 14 },
                ) + fadeIn(animationSpec = tween(durationMillis = duration))
            ).togetherWith(
                slideOutHorizontally(
                    animationSpec = tween(durationMillis = duration),
                    targetOffsetX = { width -> -direction * width / 14 },
                ) + fadeOut(animationSpec = tween(durationMillis = duration)),
            )
        },
        label = "salary-page",
    ) { visibleStage ->
        when (visibleStage) {
            SalaryStage.History -> SalaryHistoryPage(
                salaries = salaries,
                accountNames = accountNames,
                loading = historyLoading,
                refreshing = historyRefreshing,
                error = historyError,
                feedback = historyFeedback,
                deleteError = deleteError,
                canCreate = !historyLoading && historyError == null,
                onClose = onClose,
                onCreate = ::openCreateForm,
                onEdit = ::openEditForm,
                onAllocation = ::openAllocationEditor,
                onDelete = { deleteTarget = it; deleteError = null },
                onRetry = { reloadKey++ },
            )
            SalaryStage.Form -> SalaryFormPage(
                mode = formMode,
                loading = formLoading,
                loadError = formLoadError,
                formError = formError,
                amountError = amountError,
                dateError = dateError,
                allocationError = allocationFormError,
                amountText = amountText,
                dateText = dateText,
                accountId = accountId,
                note = note,
                templateId = templateId,
                templateSelectorExpanded = templateSelectorExpanded,
                accounts = accounts,
                templates = templates,
                categoryNames = categoryNames,
                editAllocations = formAllocations,
                showAllocationEditor = showFormAllocationEditor,
                allocationSum = allocationSumInForm,
                targetAmountCents = formAmountCents,
                busy = savingSalary,
                locked = salaryPendingUnknown,
                isLegacyUnkeyed = pendingSalaryOperation?.let { !isSafelyKeyedSalaryOperation(it) } ?: false,
                retryEnabled = formMode == SalaryFormMode.Edit && selectedSalaryId != null,
                onBack = ::requestBack,
                onRetry = ::retryFormDetail,
                onViewHistory = ::returnToHistory,
                onDismissLegacyPending = { showDismissLegacyDialog = true },
                onAmountChange = {
                    amountText = it
                    amountError = null
                    formError = null
                    allocationFormError = null
                },
                onDateChange = {
                    dateText = it
                    dateError = null
                    formError = null
                },
                onAccountSelect = {
                    accountId = it
                    formError = null
                },
                onNoteChange = { note = it },
                onTemplateSelect = {
                    templateId = it
                    formError = null
                },
                onTemplateSelectorExpandedChange = { templateSelectorExpanded = it },
                onRepairTemplates = onRepairTemplates,
                onAllocationChange = {
                    formAllocations = formAllocations + (it.first to it.second)
                    allocationFormError = null
                },
                onSave = {
                    if (showFormAllocationEditor) {
                        val total = allocationTotalCents(formAllocations)
                        val target = formAmountCents
                        if (total == null || target == null) {
                            allocationFormError = "请检查分配金额格式或范围。"
                        } else if (total != target) {
                            allocationFormError = allocationDifferenceMessage(total, target)
                        } else {
                            confirmSalaryAllocationReplacement = true
                        }
                    } else {
                        submitSalary()
                    }
                },
            )
            SalaryStage.Allocation -> SalaryAllocationPage(
                detail = allocationDetail,
                loading = allocationLoading,
                loadError = allocationLoadError,
                error = allocationError,
                amounts = allocationAmounts,
                categoryNames = categoryNames,
                categories = categories,
                busy = savingAllocation,
                totalCents = allocationDetail?.optLong("amountCents"),
                allocationSumCents = allocationTotalCents(allocationAmounts),
                onBack = ::requestBack,
                onRetry = ::retryAllocationDetail,
                onAmountChange = {
                    allocationAmounts = allocationAmounts + (it.first to it.second)
                    allocationError = null
                },
                onSave = {
                    val total = allocationTotalCents(allocationAmounts)
                    val target = allocationDetail?.optLong("amountCents")
                    if (total != null && target != null && total == target) {
                        confirmAllocationReplacement = true
                    } else if (total == null || target == null) {
                        allocationError = "请检查分配金额格式。"
                    } else {
                        allocationError = allocationDifferenceMessage(total, target)
                    }
                },
            )
        }
    }

    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { if (!deletingSalary) deleteTarget = null },
            title = { Text("删除这笔工资？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(formatYuan(target.optLong("amountCents")) + " · " + formatDay(target.optLong("date")))
                    Text("删除会同时移除这笔工资对应的预算分配。请确认操作对象；结果以服务器返回为准。")
                    deleteError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                Button(onClick = ::confirmDelete, enabled = !deletingSalary) {
                    if (deletingSalary) CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp)
                    else Text("删除工资")
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }, enabled = !deletingSalary) { Text("取消") }
            },
        )
    }

    if (showDismissLegacyDialog) {
        AlertDialog(
            onDismissRequest = { showDismissLegacyDialog = false },
            title = { Text("结束旧未决记录") },
            text = {
                Text("确认结束本机的旧未决记录？\n\n此操作仅清除本机的待核对标记，不会新增、修改或撤销服务端的任何工资记录。结束前请确认已在工资历史中核对过是否已入账。")
            },
            confirmButton = {
                Button(
                    onClick = {
                        scope.launch {
                            pendingSalaryOperation?.let { op ->
                                try {
                                    val scopeInfo = FinancialPrefs.resolveFinancialScope(api)
                                    replayStore.remove(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, op.operationId)
                                } catch (_: Exception) {}
                                pendingSalaryOperation = null
                                salaryPendingUnknown = false
                                showDismissLegacyDialog = false
                                historyFeedback = "已结束旧未决记录（未变更服务端工资）。"
                                returnToHistory()
                            }
                        }
                    },
                ) {
                    Text("确认结束")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDismissLegacyDialog = false }) {
                    Text("取消")
                }
            },
        )
    }

    if (confirmAllocationReplacement || confirmSalaryAllocationReplacement) {
        val isSalaryEdit = confirmSalaryAllocationReplacement
        AlertDialog(
            onDismissRequest = {
                confirmAllocationReplacement = false
                confirmSalaryAllocationReplacement = false
            },
            title = { Text(if (isSalaryEdit) "同时替换工资分配？" else "替换这笔工资的分配？") },
            text = {
                Text(
                    if (isSalaryEdit) {
                        "这次会一起保存工资字段和新的分配快照。分配合计必须等于工资金额；原分配不会自动按比例改写。"
                    } else {
                        "这会完整替换这笔工资的现有分配。工资到账金额不会改变，预算结果以服务器刷新为准。"
                    },
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        confirmAllocationReplacement = false
                        confirmSalaryAllocationReplacement = false
                        if (isSalaryEdit) submitSalary() else submitAllocationReplacement()
                    },
                    enabled = !savingSalary && !savingAllocation,
                ) { Text("确认替换") }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        confirmAllocationReplacement = false
                        confirmSalaryAllocationReplacement = false
                    },
                    enabled = !savingSalary && !savingAllocation,
                ) { Text("继续编辑") }
            },
        )
    }

    discardStage?.let {
        AlertDialog(
            onDismissRequest = { discardStage = null },
            title = { Text("放弃未保存的修改？") },
            text = { Text("当前输入尚未保存。返回工资记录会丢弃这次修改。") },
            confirmButton = {
                Button(onClick = {
                    discardStage = null
                    returnToHistory()
                }) { Text("放弃修改") }
            },
            dismissButton = {
                TextButton(onClick = { discardStage = null }) { Text("继续编辑") }
            },
        )
    }

    financialPromptSalaryId?.let { salaryId ->
        SalaryFinancialPrompt(
            api = api,
            salaryId = salaryId,
            onAuthExpired = onAuthExpired,
            onMessage = { message -> historyFeedback = message },
            onPlanConfirmed = onPlanConfirmed,
            onFinished = { financialPromptSalaryId = null },
        )
    }
}

@Composable
private fun SalaryHistoryPage(
    salaries: List<JSONObject>,
    accountNames: Map<String, String>,
    loading: Boolean,
    refreshing: Boolean,
    error: String?,
    feedback: String?,
    deleteError: String?,
    canCreate: Boolean,
    onClose: () -> Unit,
    onCreate: () -> Unit,
    onEdit: (JSONObject) -> Unit,
    onAllocation: (String) -> Unit,
    onDelete: (JSONObject) -> Unit,
    onRetry: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        SalaryPageHeader(title = "工资记录", onBack = onClose)
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("历史工资", style = MaterialTheme.typography.titleLarge)
                Text(
                    "到账金额与预算分配来自服务器记录。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(12.dp))
            Button(onClick = onCreate, enabled = canCreate, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("记录工资")
            }
        }
        if (refreshing) SalaryStateMessage("正在刷新工资记录…")
        feedback?.let { SalaryStateMessage(it) }
        error?.let { SalaryErrorMessage(message = it, onRetry = onRetry) }
        deleteError?.let { SalaryStateMessage(it, isError = true) }

        when {
            loading && salaries.isEmpty() && error == null ->
                SalaryLoadingPanel("正在读取工资记录", Modifier.weight(1f))
            error != null && salaries.isEmpty() -> {
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(vertical = 28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("暂时无法读取工资记录", style = MaterialTheme.typography.titleMedium)
                    OutlinedButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) { Text("重试") }
                }
            }
            salaries.isEmpty() -> {
                Card(Modifier.weight(1f).fillMaxWidth().padding(top = 12.dp)) {
                    Column(
                        Modifier.fillMaxWidth().padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("还没有工资记录", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "记录第一笔工资后，服务器会按已选模板生成对应的预算分配。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedButton(
                            onClick = onCreate,
                            enabled = canCreate,
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text("记录第一笔工资") }
                    }
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(salaries, key = { it.optString("id") }) { salary ->
                        val id = salary.optString("id")
                        val salaryAccountId = salary.optString("accountId")
                        Card(Modifier.fillMaxWidth()) {
                            Column(
                                Modifier.fillMaxWidth().padding(14.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Row(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        formatYuan(salary.optLong("amountCents")),
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(
                                        formatDay(salary.optLong("date")),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Text(
                                    "到账账户：" + (accountNames[salaryAccountId]
                                        ?: if (salaryAccountId.isBlank()) "未知账户" else "历史账户"),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                salary.optString("note").takeIf(String::isNotBlank)?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall)
                                }
                                Row(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    OutlinedButton(
                                        onClick = { onEdit(salary) },
                                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                            .semantics { contentDescription = "编辑工资，" + formatDay(salary.optLong("date")) },
                                    ) { Text("编辑") }
                                    OutlinedButton(
                                        onClick = { onAllocation(id) },
                                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                            .semantics { contentDescription = "修改工资分配，" + formatDay(salary.optLong("date")) },
                                    ) { Text("分配") }
                                    OutlinedButton(
                                        onClick = { onDelete(salary) },
                                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                            .semantics { contentDescription = "删除工资，" + formatDay(salary.optLong("date")) },
                                    ) { Text("删除", color = MaterialTheme.colorScheme.error) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SalaryFormPage(
    mode: SalaryFormMode,
    loading: Boolean,
    loadError: String?,
    formError: String?,
    amountError: String?,
    dateError: String?,
    allocationError: String?,
    amountText: String,
    dateText: String,
    accountId: String,
    note: String,
    templateId: String?,
    templateSelectorExpanded: Boolean,
    accounts: List<JSONObject>,
    templates: List<JSONObject>,
    categoryNames: Map<String, String>,
    editAllocations: Map<String, String>,
    showAllocationEditor: Boolean,
    allocationSum: Long?,
    targetAmountCents: Long?,
    busy: Boolean,
    locked: Boolean,
    isLegacyUnkeyed: Boolean = false,
    retryEnabled: Boolean,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onViewHistory: () -> Unit = {},
    onDismissLegacyPending: () -> Unit = {},
    onAmountChange: (String) -> Unit,
    onDateChange: (String) -> Unit,
    onAccountSelect: (String) -> Unit,
    onNoteChange: (String) -> Unit,
    onTemplateSelect: (String) -> Unit,
    onTemplateSelectorExpandedChange: (Boolean) -> Unit,
    onRepairTemplates: () -> Unit,
    onAllocationChange: (Pair<String, String>) -> Unit,
    onSave: () -> Unit,
) {
    val motion = LocalMotionTokens.current
    val inputEnabled = !busy && !locked
    val usableTemplates = remember(templates, categoryNames) {
        val activeIds = categoryNames.keys
        templates.filter { it.isUsableSalaryTemplate(activeIds) }
    }
    val defaultTemplate = remember(usableTemplates) { usableTemplates.firstOrNull { it.optBoolean("isDefault") } }
    val selectedTemplate = remember(usableTemplates, templateId) {
        usableTemplates.firstOrNull { it.optString("id") == templateId }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        SalaryPageHeader(
            title = if (mode == SalaryFormMode.Create) "记录工资" else "编辑工资",
            onBack = onBack,
        )
        when {
            loading -> SalaryLoadingPanel("正在读取工资详情…", Modifier.weight(1f))
            loadError != null -> {
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    SalaryErrorMessage(loadError, onRetry = onRetry, retryEnabled = retryEnabled)
                    OutlinedButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text("返回工资记录")
                    }
                }
            }
            else -> {
                Column(
                    Modifier.weight(1f).fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        if (mode == SalaryFormMode.Create) {
                            "填写到账信息。新工资的分配由所选模板在服务器生成。"
                        } else {
                            "编辑工资记录；模板不会重新套用，既有分配保持原样。"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    if (locked) {
                        SalaryStateMessage(
                            "上次保存结果尚未确认，输入已锁定。点击“重试确认”会发送与上次完全相同的请求，不会重复创建工资。",
                        )
                    }
                    OutlinedTextField(
                        value = amountText,
                        onValueChange = onAmountChange,
                        label = { Text("工资金额（元）") },
                        supportingText = { Text("最多两位小数；预算金额以服务器返回值为准。") },
                        isError = amountError != null,
                        enabled = inputEnabled,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    amountError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    OutlinedTextField(
                        value = dateText,
                        onValueChange = onDateChange,
                        label = { Text("到账日期") },
                        supportingText = { Text("格式：YYYY-MM-DD") },
                        isError = dateError != null,
                        enabled = inputEnabled,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    dateError?.let { Text(it, color = MaterialTheme.colorScheme.error) }

                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("到账账户", style = MaterialTheme.typography.titleMedium)
                        if (accounts.isEmpty()) {
                            Text(
                                if (mode == SalaryFormMode.Edit && accountId.isNotBlank()) {
                                    "这笔工资关联的账户当前不可用；保留历史关联仍可修改其它字段。"
                                } else {
                                    "没有可用账户，请先在分类与账户中创建账户。"
                                },
                                color = MaterialTheme.colorScheme.error,
                            )
                        } else {
                            Column(Modifier.selectableGroup()) {
                                accounts.forEach { account ->
                                    val id = account.optString("id")
                                    val selectionColor by animateColorAsState(
                                        targetValue = if (accountId == id) {
                                            MaterialTheme.colorScheme.secondaryContainer
                                        } else {
                                            Color.Transparent
                                        },
                                        animationSpec = tween(durationMillis = motion.quickMillis),
                                        label = "salary-account-selection",
                                    )
                                    Row(
                                        modifier = Modifier.fillMaxWidth()
                                            .heightIn(min = 52.dp)
                                            .background(selectionColor, RoundedCornerShape(12.dp))
                                            .selectable(
                                                selected = accountId == id,
                                                enabled = inputEnabled,
                                                role = Role.RadioButton,
                                                onClick = { onAccountSelect(id) },
                                            )
                                            .padding(horizontal = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        RadioButton(selected = accountId == id, onClick = null, enabled = inputEnabled)
                                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                                            Text(account.optString("name", "未命名账户"))
                                            account.optString("typeName").takeIf(String::isNotBlank)?.let {
                                                Text(it, style = MaterialTheme.typography.bodySmall)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (mode == SalaryFormMode.Create) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("分配模板", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "模板只用于这次新工资；之后不会自动改写历史工资。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (defaultTemplate == null) {
                                Text(
                                    "当前没有可用的默认分配模板。修复模板前不能保存工资，也不会纳入理财计划。",
                                    color = MaterialTheme.colorScheme.error,
                                )
                                OutlinedButton(
                                    onClick = onRepairTemplates,
                                    enabled = !busy && !locked,
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text("修复分配模板") }
                            } else {
                                Text(
                                    "当前模板：${selectedTemplate?.optString("name")?.takeIf(String::isNotBlank) ?: "尚未选择"}",
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.End,
                                ) {
                                    TextButton(
                                        onClick = { onTemplateSelectorExpandedChange(!templateSelectorExpanded) },
                                        enabled = inputEnabled,
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) { Text(if (templateSelectorExpanded) "收起模板" else "更换模板") }
                                }
                                if (templateSelectorExpanded) {
                                    Column(Modifier.selectableGroup()) {
                                        usableTemplates.forEach { template ->
                                            val id = template.optString("id")
                                            val selected = templateId == id
                                            val selectionColor by animateColorAsState(
                                                targetValue = if (selected) {
                                                    MaterialTheme.colorScheme.secondaryContainer
                                                } else {
                                                    Color.Transparent
                                                },
                                                animationSpec = tween(durationMillis = motion.quickMillis),
                                                label = "salary-template-selection",
                                            )
                                            Row(
                                                modifier = Modifier.fillMaxWidth()
                                                    .heightIn(min = 56.dp)
                                                    .background(selectionColor, RoundedCornerShape(12.dp))
                                                    .selectable(
                                                        selected = selected,
                                                        enabled = inputEnabled,
                                                        role = Role.RadioButton,
                                                        onClick = {
                                                            onTemplateSelect(id)
                                                            onTemplateSelectorExpandedChange(false)
                                                        },
                                                    )
                                                    .padding(horizontal = 4.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                RadioButton(selected = selected, onClick = null, enabled = inputEnabled)
                                                Column(Modifier.weight(1f).padding(start = 8.dp)) {
                                                    Text(template.optString("name", "未命名模板"))
                                                    if (template.optBoolean("isDefault")) {
                                                        Text(
                                                            "默认模板",
                                                            style = MaterialTheme.typography.bodySmall,
                                                            color = MaterialTheme.colorScheme.primary,
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    OutlinedTextField(
                        value = note,
                        onValueChange = onNoteChange,
                        label = { Text("备注（可选）") },
                        enabled = inputEnabled,
                        minLines = 2,
                        maxLines = 4,
                        modifier = Modifier.fillMaxWidth(),
                    )

                    if (showAllocationEditor) {
                        HorizontalDivider()
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("同步调整预算分配", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "工资金额变化时，服务器要求在同一次保存中提交完整分配。原分配不会自动按比例改写。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                "工资金额：" + (targetAmountCents?.let(::formatYuan) ?: "—"),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                allocationSumLabel(allocationSum, targetAmountCents),
                                color = if (allocationSum == targetAmountCents && allocationSum != null) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.error
                                },
                            )
                            allocationEditorRows(categoryNames, editAllocations).forEach { pair ->
                                val id = pair.first
                                OutlinedTextField(
                                    value = editAllocations[id].orEmpty(),
                                    onValueChange = { onAllocationChange(id to it) },
                                    label = { Text(pair.second) },
                                    supportingText = if (id !in categoryNames) {
                                        { Text("此分类不在当前列表中，保存仍会由服务器校验。") }
                                    } else null,
                                    enabled = inputEnabled,
                                    singleLine = true,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            allocationError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        }
                    }
                    if (locked && isLegacyUnkeyed) {
                        SalaryStateMessage(
                            "旧工资请求结果待核对：此历史请求缺少唯一 operationId，已禁止自动重发以防重复。请核对历史记录，确认后可显式结束本机未决记录（该操作不新增或撤销任何工资）。",
                            isError = true,
                        )
                    }
                    formError?.let { SalaryStateMessage(it, isError = true) }
                    Spacer(Modifier.height(12.dp))
                }
                if (locked && isLegacyUnkeyed) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        JzGhostButton(
                            text = "查看工资历史",
                            onClick = onViewHistory,
                            enabled = !busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        )
                        JzPrimaryButton(
                            text = "结束未决记录",
                            onClick = onDismissLegacyPending,
                            enabled = !busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        )
                    }
                } else {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        JzGhostButton(
                            text = "取消",
                            onClick = onBack,
                            enabled = !busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        )
                        JzPrimaryButton(
                            text = when {
                                busy -> "保存中…"
                                locked -> "重试确认"
                                else -> "保存工资"
                            },
                            onClick = onSave,
                            enabled = !busy && (
                                locked || (
                                    accountId.isNotBlank() &&
                                        (mode == SalaryFormMode.Edit ||
                                            (accounts.isNotEmpty() && defaultTemplate != null && selectedTemplate != null))
                                    )
                                ),
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SalaryAllocationPage(
    detail: JSONObject?,
    loading: Boolean,
    loadError: String?,
    error: String?,
    amounts: Map<String, String>,
    categoryNames: Map<String, String>,
    categories: List<JSONObject>,
    busy: Boolean,
    totalCents: Long?,
    allocationSumCents: Long?,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onAmountChange: (Pair<String, String>) -> Unit,
    onSave: () -> Unit,
) {
    Column(Modifier.fillMaxSize().imePadding()) {
        SalaryPageHeader(title = "工资分配", onBack = onBack)
        when {
            loading -> SalaryLoadingPanel("正在读取这笔工资的分配…", Modifier.weight(1f))
            loadError != null -> {
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    SalaryErrorMessage(loadError, onRetry = onRetry)
                    OutlinedButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text("返回工资记录")
                    }
                }
            }
            detail != null -> {
                Column(
                    Modifier.weight(1f).fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Card(Modifier.fillMaxWidth()) {
                        Column(
                            Modifier.fillMaxWidth().padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                "工资 " + formatYuan(detail.optLong("amountCents")),
                                style = MaterialTheme.typography.titleLarge,
                            )
                            Text(
                                "到账日期：" + formatDay(detail.optLong("date")),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                "下方合计只用于校验本次输入，预算与余额仍由服务器计算。",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    Text("模块分配（元）", style = MaterialTheme.typography.titleMedium)
                    Text(
                        allocationSumLabel(allocationSumCents, totalCents),
                        color = if (allocationSumCents == totalCents && allocationSumCents != null) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                    )
                    if (allocationDetailIsEmpty(detail)) {
                        SalaryStateMessage("服务器当前没有返回分配项，请填写完整分配后再替换。")
                    }
                    allocationEditorRows(categoryNames, amounts).forEach { pair ->
                        val id = pair.first
                        OutlinedTextField(
                            value = amounts[id].orEmpty(),
                            onValueChange = { onAmountChange(id to it) },
                            label = { Text(pair.second) },
                            supportingText = if (id !in categoryNames) {
                                { Text("历史分类已不在当前分类列表；服务器会验证该分类是否仍可用。") }
                            } else null,
                            enabled = !busy,
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (categories.isEmpty()) {
                        Text(
                            "没有可用分类。分配保存需要至少一个服务器认可的分类。",
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    error?.let { SalaryStateMessage(it, isError = true) }
                    Spacer(Modifier.height(12.dp))
                }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    JzGhostButton(
                        text = "取消",
                        onClick = onBack,
                        enabled = !busy,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    )
                    JzPrimaryButton(
                        text = if (busy) "保存中…" else "替换分配",
                        onClick = onSave,
                        enabled = !busy && categories.isNotEmpty() && amounts.isNotEmpty() &&
                            allocationSumCents != null && allocationSumCents == totalCents,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SalaryPageHeader(title: String, onBack: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
        }
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SalaryLoadingPanel(message: String, modifier: Modifier) {
    Column(
        modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(12.dp))
        Text(message)
    }
}

@Composable
private fun SalaryErrorMessage(
    message: String,
    onRetry: () -> Unit,
    retryEnabled: Boolean = true,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(message, color = MaterialTheme.colorScheme.error)
            OutlinedButton(
                onClick = onRetry,
                enabled = retryEnabled,
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("重试") }
        }
    }
}

@Composable
private fun SalaryStateMessage(message: String, isError: Boolean = false) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.medium,
    ) {
        Text(
            message,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            color = if (isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private fun allocationEditorRows(
    categoryNames: Map<String, String>,
    amounts: Map<String, String>,
): List<Pair<String, String>> {
    val rows = categoryNames.entries.map { it.key to it.value }.toMutableList()
    amounts.keys.filterNot(categoryNames::containsKey).forEach { id ->
        rows += id to ("历史分类（" + id.take(8) + "）")
    }
    return rows
}

private fun allocationMapFrom(
    detail: JSONObject,
    categoryNames: Map<String, String>,
): Map<String, String> {
    val current = linkedMapOf<String, Long>()
    val items = detail.optJSONArray("allocations")
    for (index in 0 until (items?.length() ?: 0)) {
        val item = items?.optJSONObject(index) ?: continue
        val id = item.optString("categoryId").takeIf(String::isNotBlank) ?: continue
        current[id] = item.optLong("amountCents")
    }
    val result = linkedMapOf<String, String>()
    categoryNames.keys.forEach { id -> result[id] = formatYuan(current[id] ?: 0L) }
    current.forEach { (id, cents) -> result[id] = formatYuan(cents) }
    return result
}

private fun allocationDetailIsEmpty(detail: JSONObject): Boolean =
    detail.optJSONArray("allocations")?.length() == 0

private fun allocationTotalCents(amounts: Map<String, String>): Long? {
    var total = 0L
    for (value in amounts.values) {
        val cents = parseNonNegativeCents(value) ?: return null
        total = try {
            Math.addExact(total, cents)
        } catch (_: ArithmeticException) {
            return null
        }
        if (total > MAX_SAFE_INTEGER_CENTS) return null
    }
    return total
}

private fun parseSalaryCents(value: String): Long? =
    parseNonNegativeCents(value)?.takeIf { it > 0L }

private fun parseNonNegativeCents(value: String): Long? {
    val normalized = value.trim()
    if (!normalized.matches(Regex("""\d+(?:\.\d{1,2})?"""))) return null
    val amount = try {
        BigDecimal(normalized).movePointRight(2).longValueExact()
    } catch (_: Exception) {
        return null
    }
    return amount.takeIf { it >= 0L && it <= MAX_SAFE_INTEGER_CENTS }
}

private fun allocationDifferenceMessage(total: Long, target: Long): String = when {
    total < target -> "分配还差 " + formatYuan(target - total) + " 元，与工资金额相等后才能保存。"
    total > target -> "分配超出工资金额 " + formatYuan(total - target) + " 元，请调整后再保存。"
    else -> "分配合计与工资金额一致。"
}

private fun allocationSumLabel(total: Long?, target: Long?): String = when {
    total == null -> "分配合计：请检查金额格式或范围。"
    target == null -> "分配合计：" + formatYuan(total) + " 元；工资金额尚未读取。"
    else -> "分配合计 " + formatYuan(total) + " 元 · 工资金额 " + formatYuan(target) + " 元"
}

private fun JSONObject.jsonObjects(key: String): List<JSONObject> {
    val array = optJSONArray(key) ?: return emptyList()
    return buildList {
        for (index in 0 until array.length()) {
            array.optJSONObject(index)?.let(::add)
        }
    }
}

private const val MAX_SAFE_INTEGER_CENTS = 9_007_199_254_740_991L

private fun todayStr(): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date())
