package com.yansuu1.jizhang.ui

import android.content.Context
import android.os.Build
import android.view.accessibility.AccessibilityManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Backspace
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.FinancialExecutionUnsupportedException
import com.yansuu1.jizhang.repo.LedgerRepository
import com.yansuu1.jizhang.repo.MetaRepository
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * Create or edit a transaction while preserving the complete ledger payload.
 *
 * Layout contract: the amount, the numeric keypad and the save action are fixed;
 * only the metadata groups scroll, so a large amount and the keypad stay visible
 * while typing. While the note/tag fields hold IME focus the custom keypad is
 * hidden to give the IME room, and the amount plus save action remain visible.
 *
 * @param editId existing transaction to edit. `null` means create.
 * @param refundOriginalId originating **expense** id for "record a refund".
 *   Ignored when [editId] is set (edit and refund are mutually exclusive). The
 *   seed (type=income, isRefund, link to the original, empty amount, today,
 *   visible income leaf category, original receiving account only while it is
 *   still active) is applied *before* the discard baseline, so an untouched
 *   refund draft is not reported as an unsaved change. The original expense is
 *   never modified: saving always POSTs a new income.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionEditSheet(
    api: ApiClient,
    editId: String?,
    onAuthExpired: () -> Unit,
    onSaved: () -> Unit,
    onClose: () -> Unit,
    refundOriginalId: String? = null,
    /** Income entry is a handoff to the existing salary domain, never a transaction write. */
    onOpenSalary: () -> Unit = {},
    /** The shell disables this handler while a higher modal (salary flow) owns system Back. */
    backEnabled: Boolean = true,
) {
    val scope = rememberCoroutineScope()
    val ledger = remember(api) { LedgerRepository(api) }
    val meta = remember(api) { MetaRepository(api) }
    val financial = remember(api) { FinancialExecutionRepository(api) }
    val refundSourceId = if (editId == null) refundOriginalId else null

    var type by remember { mutableStateOf(TransactionEditorHelper.EXPENSE_TYPE) }
    var amountText by remember { mutableStateOf("") }
    var categoryId by remember { mutableStateOf("") }
    var accountId by remember { mutableStateOf("") }
    var dateText by remember { mutableStateOf(todayInput()) }
    var datePickerVisible by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var tagsText by remember { mutableStateOf("") }
    var moreExpanded by remember(editId, refundSourceId) { mutableStateOf(refundSourceId != null) }
    var accountDefaultError by remember(editId, refundSourceId) { mutableStateOf<String?>(null) }
    var showTagPicker by remember { mutableStateOf(false) }
    var availableTags by remember(meta) { mutableStateOf<List<String>>(emptyList()) }
    var tagsLoading by remember(meta) { mutableStateOf(false) }
    var tagsLoadError by remember(meta) { mutableStateOf<String?>(null) }
    var tagsLoadKey by remember(meta) { mutableStateOf(0) }
    var tagSearch by remember { mutableStateOf("") }
    var refundLinks by remember { mutableStateOf("") }
    var isRefund by remember { mutableStateOf(false) }
    var financialPurpose by remember { mutableStateOf<String?>(null) }
    var purposeCapability by remember(editId, refundSourceId) {
        mutableStateOf(FinancialPurposeCapability.UNKNOWN)
    }
    var pendingPurposeOperation by remember(editId, refundSourceId) {
        mutableStateOf<PendingFinancialOperation?>(null)
    }
    var pendingPurposeScope by remember(editId, refundSourceId) { mutableStateOf<FinancialScope?>(null) }
    var pendingPurposeMessage by remember(editId, refundSourceId) { mutableStateOf<String?>(null) }
    var refundAccountUnavailable by remember { mutableStateOf(false) }
    var recordingScope by remember(editId, refundSourceId) { mutableStateOf<FinancialScope?>(null) }
    var expenseCats by remember { mutableStateOf(listOf<JSONObject>())}
    var incomeCats by remember { mutableStateOf(listOf<JSONObject>()) }
    var accounts by remember { mutableStateOf(listOf<JSONObject>()) }
    var loading by remember { mutableStateOf(true) }
    var formReady by remember { mutableStateOf(false) }
    var loadKey by remember { mutableStateOf(0) }
    /** Blocking load failure: stays visible with retry, it is never auto-dismissed. */
    var loadError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var baseline by remember(editId, refundSourceId) { mutableStateOf<TransactionEditorDraft?>(null) }
    var discardConfirmation by remember(editId, refundSourceId) { mutableStateOf(false) }
    var noteFocused by remember { mutableStateOf(false) }
    var tagsFocused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current

    val errorController = remember(editId, refundSourceId) { TransactionTopErrorController() }
    var errorEvent by remember(editId, refundSourceId) { mutableStateOf<TransactionTopErrorEvent?>(null) }
    val context = LocalContext.current
    val replayStore = remember(context) { OperationReplayStore(context) }
    val errorDurationMs = remember(context) {
        TransactionTopErrorTiming.effectiveDurationMs(recommendedTimeoutMillis(context))
    }

    val draft = TransactionEditorDraft(
        type = type,
        amountText = amountText,
        categoryId = categoryId,
        accountId = accountId,
        dateText = dateText,
        note = note,
        tagsText = tagsText,
        refundLinks = refundLinks,
        isRefund = isRefund,
        financialPurpose = if (type == TransactionEditorHelper.EXPENSE_TYPE) financialPurpose else null,
    )
    val hasUnsavedChanges = baseline != null && draft != baseline
    val expenseParentIds = remember(expenseCats) { parentCategoryIds(expenseCats) }
    val incomeParentIds = remember(incomeCats) { parentCategoryIds(incomeCats) }

    fun reportError(message: String) {
        errorEvent = errorController.show(message, errorDurationMs)
    }

    fun dismissError(eventId: Long) {
        if (errorController.dismiss(eventId)) errorEvent = errorController.event
    }

    fun requestClose() {
        if (saving) return
        if (formReady && hasUnsavedChanges) {
            discardConfirmation = true
        } else {
            onClose()
        }
    }

    fun firstSelectableId(cats: List<JSONObject>, parents: Set<String>): String =
        TransactionEditorHelper.firstLeafCategoryId(cats, parents)
            .ifEmpty { cats.firstOrNull()?.optString("id").orEmpty() }

    fun applyDraft(next: TransactionEditorDraft) {
        type = next.type
        amountText = next.amountText
        categoryId = next.categoryId
        accountId = next.accountId
        dateText = next.dateText
        note = next.note
        tagsText = next.tagsText
        refundLinks = next.refundLinks
        isRefund = next.isRefund
        financialPurpose = next.financialPurpose
        if (next.note.isNotBlank() || next.tagsText.isNotBlank() || next.financialPurpose != null) {
            moreExpanded = true
        }
    }

    /** Show the exact pending values so a retry cannot silently save another draft. */
    fun applyPendingEditorDraft(operation: PendingFinancialOperation) {
        val payload = try {
            JSONObject(operation.payloadJson)
        } catch (_: Exception) {
            return
        }
        val restored = TransactionEditorHelper.draftFromTransaction(payload)
        applyDraft(restored)
        if (payload.has("financialPurpose")) moreExpanded = true
        baseline = restored
    }

    // Catalogue loading is independent: a failed tag request cannot reset the draft
    // or block category/account loading and saving. Reopen to refresh the catalogue.
    LaunchedEffect(meta, showTagPicker, tagsLoadKey) {
        if (!showTagPicker) return@LaunchedEffect
        tagsLoading = true
        tagsLoadError = null
        try {
            availableTags = TransactionEditorHelper.tagNames(meta.tags())
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (_: Exception) {
            tagsLoadError = "已有标签加载失败，仍可手动输入。"
        } finally {
            tagsLoading = false
        }
    }

    // Capability is independent of the editor payload: an old/unknown server
    // disables the purpose chips and every save omits the optional field so the
    // ordinary ledger PATCH keeps working.
    LaunchedEffect(api, editId, refundSourceId) {
        purposeCapability = try {
            FinancialPurposeCapability.fromCapabilities(financial.getCapabilities())
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
            return@LaunchedEffect
        } catch (_: FinancialExecutionUnsupportedException) {
            FinancialPurposeCapability.LEGACY_UNSUPPORTED
        } catch (_: Exception) {
            FinancialPurposeCapability.UNKNOWN
        }
    }

    // Recover a purpose-bearing write from a previous process before this
    // editor can send a new one. A committed operation closes the editor; a
    // missing one becomes the exact pending request the save button retries.
    LaunchedEffect(api, formReady, editId, refundSourceId) {
        if (!formReady) return@LaunchedEffect
        try {
            val scopeInfo = FinancialPrefs.resolveFinancialScope(api)
            val method = if (editId == null) "POST" else "PATCH"
            val path = if (editId == null) {
                "/api/v1/transactions"
            } else {
                "/api/v1/transactions/" + financialPathSegment(editId)
            }
            val pending = replayStore.list(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity)
                .filter { it.method == method && it.path == path }
                .maxByOrNull { it.createdAt }
            if (pending != null) {
                try {
                    financial.getOperation(pending.operationId)
                    runCatching {
                        replayStore.remove(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, pending.operationId)
                    }
                    pendingPurposeOperation = null
                    pendingPurposeMessage = null
                    onSaved()
                    return@LaunchedEffect
                } catch (e: ApiException) {
                    if (e.status != 404) {
                        when (val failure = classifyFinancialWriteFailure(e)) {
                            is FinancialWriteFailure.Rejected -> {
                                runCatching {
                                    replayStore.remove(scopeInfo.serverBaseUrl, scopeInfo.storageIdentity, pending.operationId)
                                }
                                pendingPurposeMessage = failure.message
                            }
                            else -> {
                                applyPendingEditorDraft(pending)
                                pendingPurposeOperation = pending
                                pendingPurposeMessage =
                                    "上次保存结果尚未确认，点击保存会重放同一请求。"
                            }
                        }
                    } else {
                        applyPendingEditorDraft(pending)
                        pendingPurposeOperation = pending
                        pendingPurposeMessage = "检测到上次未确认的保存，点击保存会重放同一请求，不会生成新账单。"
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (_: Exception) {
            // A scope/transport failure must not block the ordinary editor; the
            // save path performs the same checks again before any mutation.
        }
    }

    BackHandler(enabled = backEnabled) { requestClose() }

    LaunchedEffect(editId, refundSourceId, loadKey) {
        loading = true
        formReady = false
        baseline = null
        discardConfirmation = false
        loadError = null
        refundAccountUnavailable = false
        accountDefaultError = null
        recordingScope = null
        moreExpanded = refundSourceId != null
        errorController.clear()
        errorEvent = null
        var loadedDraft: TransactionEditorDraft? = null
        try {
            val cats = meta.categories().optJSONArray("items")
            val ex = mutableListOf<JSONObject>()
            val inc = mutableListOf<JSONObject>()
            for (i in 0 until (cats?.length() ?: 0)) {
                val c = cats?.optJSONObject(i) ?: continue
                if (c.optInt("type") == TransactionEditorHelper.INCOME_TYPE) inc.add(c) else ex.add(c)
            }
            val accs = meta.accounts().optJSONArray("items")
            val al = mutableListOf<JSONObject>()
            for (i in 0 until (accs?.length() ?: 0)) {
                accs?.optJSONObject(i)?.let { al.add(it) }
            }

            val activeAccountIds = al.map { it.optString("id") }.filter { it.isNotBlank() }
            if (editId == null) {
                recordingScope = try {
                    FinancialPrefs.resolveAuthenticatedScope(api)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AuthExpiredException) {
                    onAuthExpired()
                    null
                } catch (_: Exception) {
                    null
                }
            }
            loadedDraft = when {
                editId != null -> TransactionEditorHelper.draftFromTransaction(ledger.getTransaction(editId))
                refundSourceId != null -> {
                    val original = ledger.getTransaction(refundSourceId)
                    if (!TransactionRefundSeedHelper.isRefundableExpense(original)) {
                        loadError = TransactionRefundSeedHelper.NOT_REFUNDABLE_EXPENSE_ERROR
                        null
                    } else {
                        val accountResult = resolveRecordingAccount(
                            lastAccountId = null,
                            activeAccountIds = activeAccountIds,
                            // Empty/missing original account is still a pinned refund account,
                            // not permission to silently use the first active account.
                            refundAccountId = original.optString("accountId"),
                        )
                        val seed = TransactionRefundSeedHelper.buildRefundSeed(
                            original = original,
                            incomeCategories = inc,
                            incomeParentIds = parentCategoryIds(inc),
                            activeAccountIds = activeAccountIds.toSet(),
                            todayText = todayInput(),
                        )
                        refundAccountUnavailable = seed.originalAccountUnavailable || accountResult.error != null
                        accountDefaultError = accountResult.error
                        seed.toDraft().copy(accountId = accountResult.accountId.orEmpty())
                    }
                }
                else -> {
                    val rememberedAccountId = try {
                        recordingScope?.let { accountScope ->
                            RecordingAccountPrefs.read(context, accountScope.serverBaseUrl, accountScope.storageIdentity)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // Account memory is an enhancement only; the active-account fallback
                        // remains available if local preferences cannot be read.
                        null
                    }
                    val accountResult = resolveRecordingAccount(
                        lastAccountId = rememberedAccountId,
                        activeAccountIds = activeAccountIds,
                        refundAccountId = null,
                    )
                    accountDefaultError = accountResult.error
                    TransactionEditorDraft(
                        type = TransactionEditorHelper.EXPENSE_TYPE,
                        amountText = "",
                        categoryId = firstSelectableId(ex, parentCategoryIds(ex)),
                        accountId = accountResult.accountId.orEmpty(),
                        dateText = todayInput(),
                        note = "",
                        tagsText = "",
                        refundLinks = "",
                        isRefund = false,
                    )
                }
            }

            expenseCats = ex
            incomeCats = inc
            accounts = al
            loadedDraft?.let {
                applyDraft(it)
                baseline = it
                formReady = true
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            loadError = e.message ?: "账单信息加载失败"
        } finally {
            loading = false
        }
    }

    if (!formReady) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)),
        ) {
            Column(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(editorTitle(editId, refundSourceId), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                if (loading) {
                    CircularProgressIndicator()
                    Text("正在加载分类和账户…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Text("账单信息没有完整加载，暂时不能保存。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    loadError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { requestClose() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("返回") }
                        Button(onClick = { loadKey++ }, modifier = Modifier.heightIn(min = 48.dp)) { Text("重试") }
                    }
                }
            }
        }
        return
    }

    val visibleCats = if (type == TransactionEditorHelper.INCOME_TYPE) incomeCats else expenseCats
    val visibleParents = if (type == TransactionEditorHelper.INCOME_TYPE) incomeParentIds else expenseParentIds
    val create = editId == null
    val targetEditId = editId

    suspend fun resolveCapability(): FinancialPurposeCapability {
        val current = purposeCapability
        if (current != FinancialPurposeCapability.UNKNOWN) return current
        return try {
            FinancialPurposeCapability.fromCapabilities(financial.getCapabilities()).also {
                purposeCapability = it
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (_: FinancialExecutionUnsupportedException) {
            FinancialPurposeCapability.LEGACY_UNSUPPORTED.also { purposeCapability = it }
        } catch (_: Exception) {
            FinancialPurposeCapability.UNKNOWN
        }
    }

    suspend fun prepareWrite(
        shouldCreate: Boolean,
        currentDraft: TransactionEditorDraft,
    ): TransactionEditorPreparedWrite {
        val baselineDraft = baseline ?: currentDraft
        val method = if (shouldCreate) "POST" else "PATCH"
        val path = if (shouldCreate) {
            "/api/v1/transactions"
        } else {
            "/api/v1/transactions/" + financialPathSegment(targetEditId.orEmpty())
        }
        val wantsExplicit = currentDraft.type == TransactionEditorHelper.EXPENSE_TYPE &&
            (if (shouldCreate) {
                currentDraft.financialPurpose != null
            } else {
                currentDraft.financialPurpose != baselineDraft.financialPurpose
            })

        // Exact pending first: after an unknown outcome (or process restart) the
        // same operationId/payload must be replayed, never replaced by a new key.
        val localPending = pendingPurposeOperation
        if (localPending != null) {
            return TransactionEditorPreparedWrite(
                payload = emptyMap(),
                replay = TransactionEditorReplayRequest(
                    operationId = localPending.operationId,
                    method = localPending.method,
                    path = localPending.path,
                    payload = JSONObject(localPending.payloadJson),
                ),
            )
        }

        val capability = resolveCapability()
        if (wantsExplicit && !capability.canChangePurpose) {
            throw IllegalStateException(
                if (capability == FinancialPurposeCapability.LEGACY_UNSUPPORTED) {
                    TransactionEditorStateHelper.PURPOSE_UNSUPPORTED_BLOCK_MESSAGE
                } else {
                    TransactionEditorStateHelper.PURPOSE_CAPABILITY_UNKNOWN_BLOCK_MESSAGE
                },
            )
        }

        // A pending write for this exact target may have survived a restart.
        if (wantsExplicit) {
            val scopeNow = FinancialPrefs.resolveFinancialScope(api)
            val stored = replayStore.list(scopeNow.serverBaseUrl, scopeNow.storageIdentity)
                .filter { it.method == method && it.path == path }
                .maxByOrNull { it.createdAt }
            if (stored != null) {
                applyPendingEditorDraft(stored)
                pendingPurposeOperation = stored
                pendingPurposeScope = scopeNow
                pendingPurposeMessage = "检测到上次未确认的保存，正在核对并重放原请求；不会生成新账单。"
                return TransactionEditorPreparedWrite(
                    payload = emptyMap(),
                    replay = TransactionEditorReplayRequest(
                        operationId = stored.operationId,
                        method = stored.method,
                        path = stored.path,
                        payload = JSONObject(stored.payloadJson),
                    ),
                )
            }
        }

        val snapshot = if (wantsExplicit && !shouldCreate) {
            val bill = financial.getBillPurpose(targetEditId.orEmpty()).billPurpose
            require(bill.transactionId == targetEditId) { "账单用途响应与当前账单不一致，请重新打开。" }
            FinancialPurposeSnapshot.from(bill)
        } else {
            null
        }
        val operationId = if (wantsExplicit) UUID.randomUUID().toString() else null
        val plan = TransactionEditorStateHelper.planPurpose(
            create = shouldCreate,
            baseline = baselineDraft,
            current = currentDraft,
            capability = capability,
            snapshot = snapshot,
            operationId = operationId,
        )
        if (!plan.includePurpose) {
            return TransactionEditorPreparedWrite(TransactionEditorHelper.buildPayloadMap(currentDraft))
        }

        val exactPayload = TransactionEditorStateHelper.buildPayload(currentDraft, plan)
        val scopeNow = FinancialPrefs.resolveFinancialScope(api)
        val pending = PendingFinancialOperation(
            operationId = requireNotNull(operationId),
            method = method,
            path = path,
            payloadJson = exactPayload.toString(),
        )
        // Synchronous durable commit before the first send. If this throws we do
        // not dispatch, so no unkeyed duplicate can be created.
        replayStore.record(scopeNow.serverBaseUrl, scopeNow.storageIdentity, pending)
        pendingPurposeOperation = pending
        pendingPurposeScope = scopeNow
        pendingPurposeMessage = "保存结果尚未确认时，重试会发送与本次完全相同的请求。"
        return TransactionEditorPreparedWrite(
            payload = emptyMap(),
            replay = TransactionEditorReplayRequest(
                operationId = pending.operationId,
                method = pending.method,
                path = pending.path,
                payload = exactPayload,
            ),
        )
    }

    suspend fun rememberSavedAccount(savedAccountId: String) {
        if (savedAccountId.isBlank()) return
        val owner = recordingScope ?: return
        try {
            RecordingAccountPrefs.write(context, owner.serverBaseUrl, owner.storageIdentity, savedAccountId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Preference persistence is best-effort; it must never turn a saved ledger row into an error.
        }
    }

    suspend fun writeReplay(request: TransactionEditorReplayRequest) {
        val scopeNow = FinancialPrefs.resolveFinancialScope(api)
        val recorded = pendingPurposeScope
        if (recorded != null &&
            (recorded.serverBaseUrl != scopeNow.serverBaseUrl || recorded.storageIdentity != scopeNow.storageIdentity)
        ) {
            throw IllegalStateException("登录用户或服务端地址已变化，已阻断保存重放；请重新打开账单。")
        }
        try {
            financial.replayOperation(request.method, request.path, request.payload)
            rememberSavedAccount(request.payload.optString("accountId"))
            val pending = pendingPurposeOperation
            if (pending != null) {
                // The server already committed. A local cleanup failure must not
                // turn a committed write into a reported failure.
                runCatching {
                    replayStore.remove(scopeNow.serverBaseUrl, scopeNow.storageIdentity, pending.operationId)
                }
            }
            pendingPurposeOperation = null
            pendingPurposeScope = null
            pendingPurposeMessage = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            when (val failure = classifyFinancialWriteFailure(e)) {
                is FinancialWriteFailure.Rejected -> {
                    val pending = pendingPurposeOperation
                    if (pending != null) {
                        runCatching {
                            replayStore.remove(scopeNow.serverBaseUrl, scopeNow.storageIdentity, pending.operationId)
                        }
                    }
                    pendingPurposeOperation = null
                    pendingPurposeScope = null
                    pendingPurposeMessage = null
                    throw IllegalStateException(failure.message)
                }
                is FinancialWriteFailure.Unknown -> {
                    pendingPurposeMessage =
                        "保存结果暂时未知：${failure.message} 点击保存会重试同一操作，不会新增账单。"
                    throw IllegalStateException(failure.message + " 请稍后重试确认同一操作。")
                }
                FinancialWriteFailure.AuthExpired -> throw AuthExpiredException()
            }
        }
    }

    // One save path for every entry point; `saving` is reserved synchronously.
    val submitter = TransactionEditorSubmitter(
        isSaving = { saving },
        setSaving = { saving = it },
        onError = { message -> reportError(message) },
        onAuthExpired = onAuthExpired,
        write = { shouldCreate, payload ->
            if (shouldCreate) ledger.createTransaction(payload)
            else ledger.updateTransaction(targetEditId.orEmpty(), payload)
            rememberSavedAccount(payload["accountId"] as? String ?: "")
        },
        onSaved = onSaved,
        prepare = { shouldCreate, currentDraft -> prepareWrite(shouldCreate, currentDraft) },
        writeReplay = { request -> writeReplay(request) },
    )

    fun submit() {
        submitter.submit(
            scope = scope,
            create = create,
            draft = draft,
            parentIds = visibleParents,
            refundAccountUnavailable = refundAccountUnavailable,
        )
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize().background(LocalWebTokens.current.bg)) {
        val fontScale = LocalDensity.current.fontScale
        val compact = maxHeight < 600.dp || fontScale >= 1.3f
        val dense = maxHeight < 460.dp

        Column(
            modifier = Modifier
                .fillMaxSize()
                // Bottom/horizontal only: the host (sheet or top bar) owns the top inset.
                // safeDrawing already unions the IME inset, so the keypad/save bar stays
                // above the IME without double padding; consumed insets resolve to zero.
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)),
        ) {
            EditorTopBar(
                title = editorTitle(editId, refundSourceId),
                saving = saving,
                retrying = pendingPurposeOperation != null,
                compact = compact,
                onCancel = { requestClose() },
                onSave = { submit() },
            )
            HorizontalDivider(color = Color(0xFFE7E4DC), thickness = 1.dp)

            // Fixed: the entered amount never scrolls out of view.
            AmountDisplay(
                amountText = amountText,
                isIncome = type == TransactionEditorHelper.INCOME_TYPE,
                compact = compact,
                dense = dense,
                onAmountClick = {
                    // IME dismissal does not remove text focus. Clear the real focus
                    // so note/tag callbacks restore the custom keypad on every tap.
                    focusManager.clearFocus(force = true)
                    keyboardController?.hide()
                },
            )

            // Bounded, independently scrolling metadata.
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp),
            ) {
                if (refundSourceId != null) {
                    Surface(
                        color = LocalWebTokens.current.accentSubtle,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            "正在记录退款：新收入自动关联原支出，原账单不会被修改；金额请按实际退款填写。",
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            fontSize = 12.sp,
                            color = LocalWebTokens.current.accent,
                        )
                    }
                }
                pendingPurposeMessage?.let { message ->
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            message,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                    }
                }

                TypeSegment(
                    isIncome = type == TransactionEditorHelper.INCOME_TYPE,
                    onExpense = {
                        type = TransactionEditorHelper.EXPENSE_TYPE
                        categoryId = firstSelectableId(expenseCats, expenseParentIds)
                        isRefund = false
                    },
                    onIncome = {
                        type = TransactionEditorHelper.INCOME_TYPE
                        categoryId = firstSelectableId(incomeCats, incomeParentIds)
                        financialPurpose = null
                    },
                )

                if (type == TransactionEditorHelper.INCOME_TYPE) {
                    OutlinedButton(
                        onClick = onOpenSalary,
                        enabled = !saving,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) {
                        Text("记工资… 使用工资分配方案")
                    }
                }

                CategoryGrid(
                    items = visibleCats,
                    parentIds = visibleParents,
                    selected = categoryId,
                    onSelect = { categoryId = it },
                )
                if (visibleParents.isNotEmpty()) {
                    Text(
                        "父分类不能直接记账，请选择子分类（服务端会拒绝父分类）。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (visibleCats.isEmpty()) {
                    Text(
                        if (type == TransactionEditorHelper.INCOME_TYPE) "暂无可用收入分类，请先添加后再保存。" else "暂无可用分类，请先添加后再保存。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                FinanceCard(
                    modifier = Modifier.fillMaxWidth(),
                    cornerRadius = 14.dp,
                    contentPadding = 12.dp,
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        CategoryPicker(
                            label = "账户",
                            items = accounts.map { it.optString("id") to it.optString("name") },
                            selected = accountId,
                            onSelect = {
                                accountId = it
                                accountDefaultError = null
                            },
                        )
                        when {
                            refundAccountUnavailable && accountId.isEmpty() -> Text(
                                TransactionEditorHelper.REFUND_ACCOUNT_UNAVAILABLE_ERROR,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                            accounts.isEmpty() -> Text(
                                accountDefaultError ?: NO_ACTIVE_RECORDING_ACCOUNT_ERROR,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clickable { datePickerVisible = true }
                                .padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("日期", style = MaterialTheme.typography.bodyMedium, color = LocalWebTokens.current.fg)
                            Text("$dateText ›", style = MaterialTheme.typography.bodyMedium, color = LocalWebTokens.current.muted)
                        }
                    }
                }

                val optionalSummary = buildList {
                    if (note.isNotBlank()) add("备注已填写")
                    if (tagsText.isNotBlank()) add("已添加标签")
                    if (financialPurpose != null) add("已指定用途")
                }.joinToString(" · ")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable {
                            if (moreExpanded && (noteFocused || tagsFocused)) {
                                focusManager.clearFocus(force = true)
                                keyboardController?.hide()
                            }
                            moreExpanded = !moreExpanded
                        }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            "更多",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = LocalWebTokens.current.fg,
                        )
                        Text(
                            optionalSummary.ifBlank { "备注、标签和理财用途（可选）" },
                            style = MaterialTheme.typography.bodySmall,
                            color = LocalWebTokens.current.muted,
                        )
                    }
                    Text(if (moreExpanded) "收起 ↑" else "展开 ↓", color = LocalWebTokens.current.accent)
                }

                if (moreExpanded) {
                    FinanceCard(
                        modifier = Modifier.fillMaxWidth(),
                        cornerRadius = 14.dp,
                        contentPadding = 12.dp,
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = note,
                                onValueChange = { note = it },
                                label = { Text("备注") },
                                placeholder = { Text("请输入备注…") },
                                singleLine = true,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .onFocusChanged { noteFocused = it.isFocused },
                            )
                            OutlinedTextField(
                                value = tagsText,
                                onValueChange = { tagsText = it },
                                label = { Text("标签") },
                                placeholder = { Text("可手动新增，逗号分隔") },
                                singleLine = true,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .onFocusChanged { tagsFocused = it.isFocused },
                            )
                            OutlinedButton(
                                enabled = !saving,
                                onClick = {
                                    focusManager.clearFocus(force = true)
                                    keyboardController?.hide()
                                    tagSearch = ""
                                    showTagPicker = true
                                },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            ) {
                                Text("选择已有标签（可多选）")
                            }
                        }
                    }
                }

                if (moreExpanded && type == TransactionEditorHelper.EXPENSE_TYPE) {
                    FormSection(
                        title = "理财用途",
                        description = "可选指定四用途周期中的归属用途；未修改时不会向服务器发送用途字段。",
                    ) {
                        val purposeEnabled = !saving && purposeCapability.canChangePurpose
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            FilterChip(
                                selected = financialPurpose == null,
                                onClick = { financialPurpose = null },
                                enabled = purposeEnabled,
                                label = { Text("跟随规则") },
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                            FilterChip(
                                selected = financialPurpose == "essentials",
                                onClick = { financialPurpose = if (financialPurpose == "essentials") null else "essentials" },
                                enabled = purposeEnabled,
                                label = { Text("必要开支") },
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                            FilterChip(
                                selected = financialPurpose == "joy",
                                onClick = { financialPurpose = if (financialPurpose == "joy") null else "joy" },
                                enabled = purposeEnabled,
                                label = { Text("随心消费") },
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                        }
                        when (purposeCapability) {
                            FinancialPurposeCapability.LEGACY_UNSUPPORTED ->
                                Text(
                                    TransactionEditorStateHelper.PURPOSE_UNSUPPORTED_MESSAGE,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            FinancialPurposeCapability.UNKNOWN ->
                                Text(
                                    TransactionEditorStateHelper.PURPOSE_CAPABILITY_UNKNOWN_MESSAGE,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            FinancialPurposeCapability.SUPPORTED -> Unit
                        }
                    }
                }

                if (type == TransactionEditorHelper.INCOME_TYPE) {
                    FormSection(title = "退款关联", description = "退款仍是一笔收入，可关联原支出；原支出记录不会被改写。") {
                        FilterChip(
                            selected = isRefund,
                            onClick = { isRefund = !isRefund },
                            label = { Text(if (isRefund) "这是退款" else "标记为退款") },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                        if (isRefund) {
                            LedgerLinkPicker(
                                api = api,
                                type = TransactionEditorHelper.EXPENSE_TYPE,
                                selected = TransactionEditorHelper.splitMultiValue(refundLinks).toSet(),
                                onSelect = { refundLinks = it.joinToString(",") },
                                multiple = true,
                                onAuthExpired = onAuthExpired,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))
            }

            // Fixed: the numeric keypad sits next to the amount. It steps aside for the
            // IME while 备注/标签 is focused so the two keyboards never stack, and the
            // amount + save action stay on screen.
            if (!noteFocused && !tagsFocused) {
                Box(Modifier.padding(horizontal = 16.dp)) {
                    AmountKeypad(
                        compact = compact,
                        dense = dense,
                        onKey = { key -> amountText = appendKeypadInput(amountText, key) },
                    )
                }
            }

            // Fixed save action, always reachable.
            Button(
                enabled = !saving,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = if (compact) 8.dp else 12.dp)
                    .height(if (dense) 42.dp else 48.dp),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = LocalWebTokens.current.accent),
                onClick = { submit() },
            ) {
                Text(
                    if (saving) "保存中…" else if (pendingPurposeOperation != null) "重试确认" else "保存",
                    fontWeight = FontWeight.Bold,
                    fontSize = if (dense) 14.sp else 16.sp,
                )
            }
        }

        // Top error event, hosted by the editor itself (inside whatever window the
        // shell gives it) so a modal sheet/dialog cannot hide it.
        errorEvent?.let { event ->
            TopErrorOverlay(
                event = event,
                onDismiss = { dismissError(it) },
                modifier = Modifier.align(Alignment.TopCenter).padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }

    if (showTagPicker) {
        val selectedTags = TransactionEditorHelper.splitMultiValue(tagsText).toSet()
        val choices = (availableTags + selectedTags).distinct().filter { it.contains(tagSearch.trim(), ignoreCase = true) }
        AlertDialog(
            onDismissRequest = { showTagPicker = false },
            title = { Text("选择已有标签") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("可多选，勾选即时更新草稿；保存账单后才生效。", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(
                        value = tagSearch,
                        onValueChange = { tagSearch = it },
                        label = { Text("搜索标签") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (tagsLoading) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp))
                    }
                    tagsLoadError?.let { message ->
                        Text(message, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { tagsLoadKey++ }, enabled = !tagsLoading) { Text("重试标签") }
                    }
                    if (!tagsLoading && tagsLoadError == null && choices.isEmpty()) {
                        Text(if (tagSearch.isBlank()) "暂无已有标签，可返回手动输入。" else "没有匹配标签。")
                    }
                    LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp)) {
                        items(choices, key = { it }) { name ->
                            Row(
                                modifier = Modifier.fillMaxWidth()
                                    .clickable { tagsText = TransactionEditorHelper.toggleTag(tagsText, name) }
                                    .heightIn(min = 48.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(
                                    checked = name in selectedTags,
                                    onCheckedChange = { tagsText = TransactionEditorHelper.toggleTag(tagsText, name) },
                                )
                                Text(name, modifier = Modifier.weight(1f))
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showTagPicker = false }) { Text("完成") } },
        )
    }

    if (datePickerVisible) {
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = datePickerUtcMillis(dateText))
        DatePickerDialog(
            onDismissRequest = { datePickerVisible = false },
            confirmButton = {
                TextButton(onClick = {
                    pickerState.selectedDateMillis?.let { dateText = dateFromPickerUtcMillis(it) }
                    datePickerVisible = false
                }) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { datePickerVisible = false }) { Text("取消") } },
        ) {
            DatePicker(state = pickerState)
        }
    }

    if (discardConfirmation) {
        AlertDialog(
            onDismissRequest = { discardConfirmation = false },
            title = { Text("放弃未保存的账单？") },
            text = { Text("当前表单有未保存的修改，离开后这些内容将丢失。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        discardConfirmation = false
                        onClose()
                    },
                ) { Text("放弃修改") }
            },
            dismissButton = {
                TextButton(onClick = { discardConfirmation = false }) { Text("继续编辑") }
            },
        )
    }
}

private fun editorTitle(editId: String?, refundOriginalId: String?): String = when {
    editId != null -> "编辑账单"
    refundOriginalId != null -> "记录退款"
    else -> "记一笔"
}

/** TalkBack may request a longer dwell time than the 4.5s baseline (API 29+). */
private fun recommendedTimeoutMillis(context: Context): Int? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager ?: return null
    return manager.getRecommendedTimeoutMillis(
        TransactionTopErrorTiming.DEFAULT_DURATION_MS.toInt(),
        AccessibilityManager.FLAG_CONTENT_CONTROLS,
    )
}

@Composable
private fun EditorTopBar(
    title: String,
    saving: Boolean,
    retrying: Boolean,
    compact: Boolean,
    onCancel: () -> Unit,
    onSave: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .padding(horizontal = 16.dp, vertical = if (compact) 8.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            "取消",
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Medium,
            color = LocalWebTokens.current.accent,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable { onCancel() }
                .padding(horizontal = 8.dp, vertical = 8.dp),
        )
        Text(
            title,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = LocalWebTokens.current.fg,
        )
        Text(
            if (saving) "保存中…" else if (retrying) "重试确认" else "保存",
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Bold,
            color = if (!saving) LocalWebTokens.current.accent else LocalWebTokens.current.muted,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(enabled = !saving) { onSave() }
                .padding(horizontal = 8.dp, vertical = 8.dp),
        )
    }
}

/** Fixed amount readout: large money first, decorative hints only when there is room. */
@Composable
private fun AmountDisplay(
    amountText: String,
    isIncome: Boolean,
    compact: Boolean,
    dense: Boolean,
    onAmountClick: () -> Unit,
) {
    val fontSize = when {
        dense -> 22.sp
        compact -> 26.sp
        else -> 32.sp
    }
    FinanceCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = if (dense) 6.dp else 10.dp),
        cornerRadius = if (compact) 14.dp else 18.dp,
        contentPadding = if (dense) 10.dp else 14.dp,
        onClick = onAmountClick,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 6.dp),
        ) {
            if (!compact) {
                Text(
                    if (isIncome) "收入金额" else "支出金额",
                    fontSize = 11.sp,
                    color = LocalWebTokens.current.muted,
                )
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Text(
                    "¥",
                    fontSize = if (dense) 16.sp else 22.sp,
                    fontWeight = FontWeight.Bold,
                    color = LocalWebTokens.current.fg,
                    modifier = Modifier.padding(end = 4.dp),
                )
                Text(
                    text = if (amountText.isBlank()) "0.00" else amountText,
                    fontSize = fontSize,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                    color = LocalWebTokens.current.fg,
                )
            }
            Text(
                "点击金额，切换数字键盘",
                fontSize = 11.sp,
                color = LocalWebTokens.current.muted,
            )
        }
    }
}

/** Expense/income pill segment; switching type re-selects the first child category. */
@Composable
private fun TypeSegment(
    isIncome: Boolean,
    onExpense: () -> Unit,
    onIncome: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        TypeSegmentButton(
            label = "支出",
            selected = !isIncome,
            onClick = onExpense,
            modifier = Modifier.weight(1f),
        )
        TypeSegmentButton(
            label = "收入",
            selected = isIncome,
            onClick = onIncome,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun TypeSegmentButton(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .height(38.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(if (selected) LocalWebTokens.current.accent else Color(0xFFE8F1F4))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (selected) Color.White else LocalWebTokens.current.accent,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** Top error overlay with accessibility live region and an explicit close action. */
@Composable
private fun TopErrorOverlay(
    event: TransactionTopErrorEvent,
    onDismiss: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(event.eventId) {
        delay(event.durationMs)
        onDismiss(event.eventId)
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Assertive },
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.errorContainer,
        shadowElevation = 6.dp,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                event.message,
                modifier = Modifier.weight(1f),
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodyMedium,
            )
            IconButton(onClick = { onDismiss(event.eventId) }, modifier = Modifier.size(44.dp)) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = "关闭错误提示",
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** Numeric keypad appends to the same amount text; the system keyboard stays usable. */
@Composable
private fun AmountKeypad(
    compact: Boolean,
    dense: Boolean,
    onKey: (String) -> Unit,
) {
    val rows = listOf(
        listOf("1", "2", "3"),
        listOf("4", "5", "6"),
        listOf("7", "8", "9"),
        listOf(".", "0", "back"),
    )
    val keyHeight = when {
        dense -> 34.dp
        compact -> 40.dp
        else -> 46.dp
    }
    val keyFont = if (dense) 15.sp else 18.sp
    Column(verticalArrangement = Arrangement.spacedBy(if (dense) 4.dp else 6.dp)) {
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { key ->
                    if (key == "back") {
                        Surface(
                            onClick = { onKey("back") },
                            modifier = Modifier.weight(1f).height(keyHeight),
                            shape = RoundedCornerShape(10.dp),
                            color = LocalWebTokens.current.surface,
                            border = BorderStroke(1.dp, LocalWebTokens.current.border.copy(alpha = 0.6f)),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Icon(
                                    Icons.Filled.Backspace,
                                    contentDescription = "删除一位",
                                    modifier = Modifier.size(18.dp),
                                    tint = LocalWebTokens.current.fg,
                                )
                            }
                        }
                    } else {
                        Surface(
                            onClick = { onKey(key) },
                            modifier = Modifier.weight(1f).height(keyHeight),
                            shape = RoundedCornerShape(10.dp),
                            color = LocalWebTokens.current.surface,
                            border = BorderStroke(1.dp, LocalWebTokens.current.border.copy(alpha = 0.6f)),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Text(
                                    key,
                                    fontSize = keyFont,
                                    fontWeight = FontWeight.SemiBold,
                                    fontFamily = FontFamily.Monospace,
                                    color = LocalWebTokens.current.fg,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Keypad editing rule: digits append, single dot, empty-safe backspace.
 * Decimal input keeps at most two places; longer input is ignored, never reformatted.
 */
fun appendKeypadInput(current: String, key: String): String {
    if (key == "back") {
        if (current.isEmpty()) return ""
        return current.dropLast(1)
    }
    if (key == ".") {
        if (current.contains(".")) return current
        if (current.isEmpty()) return "0."
        return "$current."
    }
    if (key.length != 1 || !key[0].isDigit()) return current
    if (current.length >= 12) return current
    val dot = current.indexOf(".")
    if (dot >= 0 && current.length - dot - 1 >= 2) return current
    if (current == "0") return key
    return current + key
}

/** Parent categories have children pointing at them via parentId; the server rejects them. */
fun parentCategoryIds(cats: List<JSONObject>): Set<String> {
    val childParents = cats
        .mapNotNull { c -> c.optString("parentId").takeIf { !c.isNull("parentId") && it.isNotBlank() } }
        .toSet()
    if (childParents.isEmpty()) return emptySet()
    return cats.map { it.optString("id") }.filter { it.isNotBlank() && it in childParents }.toSet()
}

/** 4-column soft tiles with category icon and color; parent categories render disabled with a hint. */
@Composable
private fun CategoryGrid(
    items: List<JSONObject>,
    parentIds: Set<String>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    if (items.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items.chunked(4).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { item ->
                    val id = item.optString("id")
                    val name = item.optString("name").ifBlank { "未命名" }
                    val iconName = item.optString("icon", "other")
                    val colorVal = categoryThemeColor(iconName, item.optLong("color", 0L))
                    val isParent = id in parentIds
                    val isSelected = id == selected && !isParent

                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .then(if (isParent) Modifier.alpha(0.45f) else Modifier)
                            .clickable(enabled = !isParent) { onSelect(id) },
                        shape = RoundedCornerShape(16.dp),
                        color = Color.White,
                        border = BorderStroke(
                            if (isSelected) 1.5.dp else 1.dp,
                            if (isSelected) LocalWebTokens.current.accent
                            else LocalWebTokens.current.border,
                        ),
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            FinanceCategoryIcon(
                                iconName = iconName,
                                categoryName = name,
                                backgroundColor = colorVal,
                                size = 36.dp,
                                iconSize = 18.dp,
                            )
                            Text(
                                name,
                                fontSize = 11.sp,
                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                color = if (isSelected) LocalWebTokens.current.accent
                                else LocalWebTokens.current.muted,
                                maxLines = 1,
                            )
                            if (isParent) {
                                Text(
                                    "父分类",
                                    fontSize = 10.sp,
                                    color = LocalWebTokens.current.muted,
                                )
                            }
                        }
                    }
                }
                repeat(4 - row.size) {
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun FormSection(
    title: String,
    description: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            content()
        }
    }
}

@Composable
private fun CategoryPicker(
    label: String,
    items: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val current = items.firstOrNull { it.first == selected }?.second ?: if (selected.isNotEmpty()) "已选项目暂不可用" else "请选择$label"
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(current, modifier = Modifier.weight(1f), maxLines = 1)
                Text("⌄")
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                items.forEach { (id, name) ->
                    DropdownMenuItem(
                        text = { Text(if (id == selected) "✓  $name" else name) },
                        onClick = { onSelect(id); expanded = false },
                    )
                }
            }
        }
        if (items.isEmpty()) {
            Text("暂无可用$label，请先添加后再保存。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

/** Convert a yuan value exactly once at the API boundary. */
fun parseYuanToCents(text: String): Long? {
    val v = text.trim().toDoubleOrNull() ?: return null
    if (!v.isFinite() || v < 0 || v * 100 > 9_007_199_254_740_991.0) return null
    return Math.round(v * 100)
}

private fun todayInput(): String = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date())

private fun datePickerUtcMillis(text: String): Long {
    val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
        isLenient = false
        timeZone = TimeZone.getTimeZone("UTC")
    }
    return try {
        formatter.parse(text)?.time ?: formatter.parse(todayInput())!!.time
    } catch (_: Exception) {
        formatter.parse(todayInput())!!.time
    }
}

private fun dateFromPickerUtcMillis(epochMs: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date(epochMs))
