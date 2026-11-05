package com.yansuu1.jizhang.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.AuthRepository
import com.yansuu1.jizhang.repo.BudgetRepository
import com.yansuu1.jizhang.repo.FinancialExecution
import com.yansuu1.jizhang.repo.FinancialExecutionRepository
import com.yansuu1.jizhang.repo.LedgerRepository
import com.yansuu1.jizhang.repo.MetaRepository
import com.yansuu1.jizhang.repo.RecurringRepository
import com.yansuu1.jizhang.repo.SpendingPurpose
import com.yansuu1.jizhang.repo.StatsRepository
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 首页仪表盘 (A5). Mirrors web `DashboardView.vue`:
 * - asset card (STOCK, all-time balances) separate from month summary (FLOW).
 *   Balances load independently via [DashboardBalancesCoordinator] from `MetaRepository.balances()`
 *   without hardcoded allocations, using authoritative `totalBalanceCents` and dynamic items.
 * - month income/net from `monthlyTrend(1)` current server month — never summed from rows.
 * - budget totals, carryover and module remaining from `budget/overview`.
 *   Progress ratios are visual only; the UI does not invent total money values.
 * - recent 5 rows from `transactions.list({limit:5})`.
 * - recurring reminder card: explicit `generate` then pending count; failures
 *   shown separately so they cannot blank the dashboard.
 */
@Composable
fun DashboardTab(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onSeeAllTransactions: () -> Unit,
    onOpenTransaction: (String) -> Unit,
    onPending: () -> Unit,
    onOpenPlan: () -> Unit = {},
    onOpenStats: () -> Unit = {},
    refreshToken: Long = 0L,
) {
    val scope = rememberCoroutineScope()
    val stats = remember(api) { StatsRepository(api) }
    val ledger = remember(api) { LedgerRepository(api) }
    val budget = remember(api) { BudgetRepository(api) }
    val meta = remember(api) { MetaRepository(api) }
    val recurring = remember(api) { RecurringRepository(api) }
    val fpRepo = remember(api) { FinancialExecutionRepository(api) }
    val auth = remember(api) { AuthRepository(api) }
    val context = LocalContext.current

    var homeMode by remember { mutableStateOf(HomeBudgetMode.CATEGORY) }
    var executionData by remember { mutableStateOf<FinancialExecution?>(null) }

    // 独立余额管理与状态
    val balancesCoordinator = remember { DashboardBalancesCoordinator() }
    var balancesState by remember { mutableStateOf(balancesCoordinator.state) }

    // 主模块数据状态
    var mainLoading by remember { mutableStateOf(true) }
    var mainError by remember { mutableStateOf<String?>(null) }
    var mainHasLoaded by remember { mutableStateOf(false) }
    var mainGeneration by remember { mutableStateOf(0L) }

    var monthLabelText by remember { mutableStateOf("本月概览") }
    var income by remember { mutableStateOf<Long?>(null) }
    var netExpense by remember { mutableStateOf<Long?>(null) }
    var budgetOverview by remember { mutableStateOf<JSONObject?>(null) }
    var budgetAlert by remember { mutableStateOf<String?>(null) }
    var budgetAlertDanger by remember { mutableStateOf(false) }
    var recents by remember { mutableStateOf(listOf<JSONObject>()) }
    var catNames by remember { mutableStateOf(mapOf<String, String>()) }
    var catIcons by remember { mutableStateOf(mapOf<String, String>()) }
    var catColors by remember { mutableStateOf(mapOf<String, Long>()) }
    var pendingCount by remember { mutableStateOf(0) }
    var recurringError by remember { mutableStateOf<String?>(null) }

    suspend fun reloadBalances() {
        val gen = balancesCoordinator.startLoad()
        balancesState = balancesCoordinator.state
        try {
            val bals = meta.balances()
            coroutineContext.ensureActive()
            val snapshot = DashboardBalancesHelper.decodeBalancesJson(bals)
            if (balancesCoordinator.onLoadSuccess(gen, snapshot)) {
                balancesState = balancesCoordinator.state
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            val msg = e.message ?: "账户余额加载失败"
            if (balancesCoordinator.onLoadError(gen, msg)) {
                balancesState = balancesCoordinator.state
            }
        } finally {
            if (balancesCoordinator.onLoadFinally(gen)) {
                balancesState = balancesCoordinator.state
            }
        }
    }

    suspend fun reloadMain() {
        mainGeneration++
        val gen = mainGeneration
        mainLoading = true
        mainError = null
        try {
            val trend = stats.monthlyTrend(1)
            coroutineContext.ensureActive()
            val list = ledger.listTransactions(mapOf("limit" to "5"))
            coroutineContext.ensureActive()
            val ov = budget.overview()
            coroutineContext.ensureActive()
            val cats = meta.categories()
            coroutineContext.ensureActive()

            val items = trend.optJSONArray("items")
            val cur = if ((items?.length() ?: 0) > 0) {
                items!!.optJSONObject(items.length() - 1)
            } else null

            val nextMonthLabel = cur?.let { "${formatMonth(it.optLong("monthStart"))}概览" } ?: "本月概览"
            val arr = list.optJSONArray("items")
            val rl = mutableListOf<JSONObject>()
            for (i in 0 until (arr?.length() ?: 0)) rl.add(arr!!.optJSONObject(i))
            val cn = mutableMapOf<String, String>()
            val ci = mutableMapOf<String, String>()
            val cc = mutableMapOf<String, Long>()
            val car = cats.optJSONArray("items")
            for (i in 0 until (car?.length() ?: 0)) {
                val c = car!!.optJSONObject(i)
                val id = c.optString("id")
                cn[id] = c.optString("name")
                ci[id] = c.optString("icon", "other")
                cc[id] = c.optLong("color", 0L)
            }

            if (gen != mainGeneration) return

            // Publish the primary dashboard snapshot together so a failed refresh
            // cannot mix newly fetched budget data with stale ledger data.
            budgetOverview = ov
            recents = rl
            catNames = cn
            catIcons = ci
            catColors = cc
            monthLabelText = nextMonthLabel
            income = cur?.optLong("incomeCents")
            netExpense = cur?.optLong("netExpenseCents")
            mainHasLoaded = true

            if (ov.optBoolean("hasBudget", false)) {
                val mods = ov.optJSONArray("modules")
                var over = 0
                var near = 0
                for (i in 0 until (mods?.length() ?: 0)) {
                    val m = mods!!.optJSONObject(i)
                    val b = m.optLong("budgetCents")
                    val s = m.optLong("spentCents")
                    if (b > 0) {
                        val p = s.toFloat() / b.toFloat()
                        if (p > 1) over++ else if (p >= 0.8) near++
                    } else if (s > 0) {
                        over++
                    }
                }
                val poolNeg = ov.optLong("carryoverPoolCents") < 0
                if (over > 0 && poolNeg) {
                    budgetAlert = "有 $over 个模块超支，已从结余池借用"
                    budgetAlertDanger = true
                } else if (over > 0) {
                    budgetAlert = "有 $over 个模块超支"
                    budgetAlertDanger = true
                } else if (poolNeg) {
                    budgetAlert = "结余池已被透支，本周期支出超过了预算"
                    budgetAlertDanger = true
                } else if (near > 0) {
                    budgetAlert = "有 $near 个模块接近上限"
                    budgetAlertDanger = false
                } else {
                    budgetAlert = null
                }
            } else {
                budgetAlert = null
                budgetAlertDanger = false
            }

            // Keep the dashboard usable while making reminder failures visible.
            try {
                val execResp = fpRepo.getCurrentExecution()
                executionData = execResp.execution
            } catch (_: Exception) {}

            try {
                val authScope = FinancialPrefs.resolveAuthenticatedScope(api)
                homeMode = FinancialPrefs.readHomeBudgetMode(context, authScope.serverBaseUrl, authScope.storageIdentity)
            } catch (_: Exception) {}

            try {
                recurring.generate()
                coroutineContext.ensureActive()
                val pend = recurring.pending()
                coroutineContext.ensureActive()
                if (gen == mainGeneration) {
                    pendingCount = pend.optInt("total", pend.optJSONArray("items")?.length() ?: 0)
                    recurringError = null
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                throw e
            } catch (e: Exception) {
                if (gen == mainGeneration) {
                    recurringError = "周期账单提醒加载失败：${e.message ?: "请重试"}"
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            if (gen == mainGeneration) {
                mainError = e.message ?: "加载失败"
            }
        } finally {
            if (gen == mainGeneration) {
                mainLoading = false
            }
        }
    }

    suspend fun reloadRecurring() {
        try {
            recurring.generate()
            coroutineContext.ensureActive()
            val pend = recurring.pending()
            coroutineContext.ensureActive()
            pendingCount = pend.optInt("total", pend.optJSONArray("items")?.length() ?: 0)
            recurringError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            recurringError = "周期账单提醒加载失败：${e.message ?: "请重试"}"
        }
    }

    fun reloadAll() {
        scope.launch { reloadBalances() }
        scope.launch { reloadMain() }
    }

    LaunchedEffect(refreshToken) {
        launch { reloadBalances() }
        launch { reloadMain() }
    }

    val isRefreshingAny = mainLoading || balancesState.loading

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // 顶部标题栏：首页 + 服务端当前月份副标题 + 显式刷新按钮
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(
                    "首页",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    color = LocalWebTokens.current.fg,
                )
                Text(
                    text = "${shortMonth(monthLabelText)} · ${dateSubtitle()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = LocalWebTokens.current.muted,
                )
            }
            IconButton(
                onClick = { reloadAll() },
                enabled = !isRefreshingAny,
            ) {
                Icon(
                    imageVector = Icons.Default.Refresh,
                    contentDescription = "刷新首页",
                    tint = if (isRefreshingAny) LocalWebTokens.current.muted else LocalWebTokens.current.accent,
                )
            }
        }

        // 独立资产余额大卡（不受主模块加载/错误阻断）
        FinanceHeroBalanceCard(
            state = balancesState,
            onRetry = { scope.launch { reloadBalances() } },
        )

        // 本月计划入口：计划页是底部一级页面，首页只保留一个明确入口，避免
        // “预算与理财规划 / 四用途执行 / 分类信封”多套入口并列。
        FinanceCard(
            modifier = Modifier.fillMaxWidth(),
            onClick = onOpenPlan,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        "本月计划",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = LocalWebTokens.current.fg,
                    )
                    Text(
                        "可花额度、已花、剩余与存钱预留",
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalWebTokens.current.muted,
                    )
                }
                Text(
                    "›",
                    style = MaterialTheme.typography.headlineSmall,
                    color = LocalWebTokens.current.accent,
                )
            }
        }

        // Navigation remains available even if the primary dashboard request fails.
        FinanceCard(
            modifier = Modifier.fillMaxWidth(),
            onClick = onOpenStats,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        "统计分析",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = LocalWebTokens.current.fg,
                    )
                    Text(
                        "查看收支趋势与分类明细",
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalWebTokens.current.muted,
                    )
                }
                Text(
                    "›",
                    style = MaterialTheme.typography.headlineSmall,
                    color = LocalWebTokens.current.accent,
                )
            }
        }

        // 主模块内容（收支、预算、待办、最近账单）
        if (mainLoading && !mainHasLoaded) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(24.dp))
                Text("正在加载收支与预算数据...", style = MaterialTheme.typography.bodySmall, color = LocalWebTokens.current.muted)
            }
        } else if (mainError != null && !mainHasLoaded) {
            JzCard(Modifier.fillMaxWidth()) {
                Text("首页数据暂时无法加载", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
                Text(mainError!!, style = MaterialTheme.typography.bodySmall)
                JzGhostButton(text = "重试首页数据", onClick = { scope.launch { reloadMain() } }, enabled = !mainLoading)
            }
        } else {
            if (mainLoading && mainHasLoaded) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("正在更新首页数据；当前保留上次结果。", style = MaterialTheme.typography.bodySmall)
                }
            }
            if (mainError != null && mainHasLoaded) {
                JzCard(Modifier.fillMaxWidth()) {
                    Text("首页数据更新失败", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
                    Text("${mainError}；当前仍显示上次成功的数据。", style = MaterialTheme.typography.bodySmall)
                    JzGhostButton(text = "重试", onClick = { scope.launch { reloadMain() } }, enabled = !mainLoading)
                }
            }

            // 本月收入 & 本月支出 双卡（1:1 对齐 Ardot 7:101）
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                FinanceCard(
                    modifier = Modifier.weight(1f),
                    cornerRadius = 18.dp,
                    contentPadding = 14.dp,
                ) {
                    Text("本月收入", fontSize = 11.sp, color = LocalWebTokens.current.muted)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "¥ ${income?.let(::formatYuan) ?: "0.00"}",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        color = LocalWebTokens.current.ok,
                    )
                }
                FinanceCard(
                    modifier = Modifier.weight(1f),
                    cornerRadius = 18.dp,
                    contentPadding = 14.dp,
                ) {
                    Text("本月支出", fontSize = 11.sp, color = LocalWebTokens.current.muted)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "¥ ${netExpense?.let(::formatYuan) ?: "0.00"}",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        color = LocalWebTokens.current.danger,
                    )
                }
            }

            // 本周期预算卡片与警告
            val overview = budgetOverview
            val hasBudget = overview?.optBoolean("hasBudget", false) == true
            val totalBudget = overview?.optLong("totalBudgetCents") ?: 0L
            val totalSpent = overview?.optLong("totalSpentCents") ?: 0L
            val remaining = (totalBudget - totalSpent).coerceAtLeast(0L)
            val ratio = if (totalBudget > 0L) {
                (totalSpent.toDouble() / totalBudget.toDouble()).toFloat().coerceIn(0f, 1f)
            } else {
                if (totalSpent > 0L) 1f else 0f
            }
            val motion = LocalMotionTokens.current
            val progress by animateFloatAsState(
                targetValue = ratio,
                animationSpec = tween(durationMillis = motion.baseMillis, easing = FastOutSlowInEasing),
                label = "dashboard-budget-progress",
            )

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 2.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (homeMode == HomeBudgetMode.PURPOSE) "四用途执行" else "本周期预算",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            color = LocalWebTokens.current.fg,
                        )
                        // 首页展示模式切换标签
                        val btnFg = LocalWebTokens.current.muted
                        Surface(
                            onClick = {
                                val next = if (homeMode == HomeBudgetMode.PURPOSE) HomeBudgetMode.CATEGORY else HomeBudgetMode.PURPOSE
                                homeMode = next
                                scope.launch {
                                    try {
                                        val authScope = FinancialPrefs.resolveAuthenticatedScope(api)
                                        FinancialPrefs.writeHomeBudgetMode(context, authScope.serverBaseUrl, authScope.storageIdentity, next)
                                    } catch (_: Exception) {}
                                }
                            },
                            shape = RoundedCornerShape(10.dp),
                            color = Color(0xFFF0EFEB),
                            modifier = Modifier.padding(start = 4.dp),
                        ) {
                            Text(
                                text = if (homeMode == HomeBudgetMode.PURPOSE) "切为分类" else "切为用途",
                                fontSize = 10.5.sp,
                                color = btnFg,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                    Text(
                        if (homeMode == HomeBudgetMode.PURPOSE) {
                            val essentials = executionData?.spending?.firstOrNull { it.purpose == SpendingPurpose.ESSENTIALS }
                            if (essentials != null) "必要剩余 ¥${formatYuan(essentials.remainingCents)}" else "暂无执行方案"
                        } else {
                            if (hasBudget) "剩余 ¥${formatYuan(remaining)}" else "未设置预算"
                        },
                        fontSize = 11.sp,
                        color = LocalWebTokens.current.muted,
                    )
                }
                FinanceCard(
                    modifier = Modifier.fillMaxWidth(),
                    cornerRadius = 18.dp,
                    contentPadding = 14.dp,
                ) {
                    if (homeMode == HomeBudgetMode.PURPOSE && executionData != null) {
                        val essentials = executionData!!.spending.firstOrNull { it.purpose == SpendingPurpose.ESSENTIALS }
                        val joy = executionData!!.spending.firstOrNull { it.purpose == SpendingPurpose.JOY }
                        val eSpent = essentials?.netCents ?: 0L
                        val eTarget = essentials?.targetCents ?: 0L
                        val jSpent = joy?.netCents ?: 0L
                        val jTarget = joy?.targetCents ?: 0L
                        val totalNet = eSpent + jSpent
                        val totalCeil = eTarget + jTarget

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("必要+随心", fontSize = 11.sp, color = LocalWebTokens.current.muted)
                            Text(
                                "¥ ${formatYuan(totalNet)} / ¥ ${formatYuan(totalCeil)}",
                                fontSize = 13.5.sp,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                color = LocalWebTokens.current.fg,
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        val pRatio = if (totalCeil > 0L) (totalNet.toFloat() / totalCeil.toFloat()).coerceIn(0f, 1f) else 0f
                        LinearProgressIndicator(
                            progress = { pRatio },
                            modifier = Modifier.fillMaxWidth().height(7.dp).clip(RoundedCornerShape(3.5.dp)),
                            color = LocalWebTokens.current.accent,
                            trackColor = Color(0xFFE9E7E1),
                        )
                    } else {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("日常生活", fontSize = 11.sp, color = LocalWebTokens.current.muted)
                            Text(
                                "¥ ${formatYuan(totalSpent)} / ¥ ${formatYuan(totalBudget)}",
                                fontSize = 13.5.sp,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                color = LocalWebTokens.current.fg,
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        LinearProgressIndicator(
                            progress = { progress },
                            modifier = Modifier.fillMaxWidth().height(7.dp).clip(RoundedCornerShape(3.5.dp)),
                            color = LocalWebTokens.current.accent,
                            trackColor = Color(0xFFE9E7E1),
                        )
                    }
                }
            }

            if (pendingCount > 0) {
                FinanceCard(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onPending,
                    backgroundColor = LocalWebTokens.current.warning.copy(alpha = 0.08f),
                    borderColor = LocalWebTokens.current.warning.copy(alpha = 0.3f),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("待确认周期账单", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Text("$pendingCount 笔需要核对", color = LocalWebTokens.current.warning, style = MaterialTheme.typography.bodyMedium)
                        }
                        Text("›", style = MaterialTheme.typography.headlineSmall, color = LocalWebTokens.current.warning)
                    }
                }
            }

            recurringError?.let {
                JzCard(Modifier.fillMaxWidth()) {
                    Text(it, color = MaterialTheme.colorScheme.error)
                    JzGhostButton(text = "重试提醒", onClick = { scope.launch { reloadRecurring() } })
                }
            }

            FinanceSectionHeader(
                title = "最近账单",
                actionText = "查看全部 ›",
                onActionClick = onSeeAllTransactions,
            )
            FinanceCard(modifier = Modifier.fillMaxWidth(), contentPadding = 10.dp) {
                if (recents.isEmpty()) {
                    FinanceEmptyState(
                        text = "还没有账单记录",
                        subtext = "记下一笔后，这里会显示最近账单。",
                    )
                } else {
                    recents.forEachIndexed { index, tx ->
                        val catId = tx.optString("categoryId")
                        val category = catNames[catId].orEmpty()
                        val title = tx.optString("note").ifEmpty { category.ifEmpty { "未分类" } }
                        val detail = if (category.isNotEmpty() && category != title) {
                            "${formatDay(tx.optLong("date"))} · $category"
                        } else {
                            formatDay(tx.optLong("date"))
                        }
                        val isIncome = tx.optInt("type") == 1
                        val iconName = catIcons[catId]
                        val colorVal = categoryThemeColor(iconName, catColors[catId])

                        val timeStr = java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA).format(java.util.Date(tx.optLong("date")))
                        FinanceTransactionListItem(
                            title = title,
                            subtitle = detail,
                            amountText = formatYuan(tx.optLong("amountCents")),
                            isIncome = isIncome,
                            categoryIcon = iconName,
                            categoryColor = colorVal,
                            timeText = timeStr,
                            onClick = { onOpenTransaction(tx.optString("id")) },
                        )
                        if (index < recents.lastIndex) {
                            HorizontalDivider(
                                modifier = Modifier.padding(start = 50.dp),
                                color = LocalWebTokens.current.border.copy(alpha = 0.45f),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DashboardMoneyMetric(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurface,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = LocalWebTokens.current.muted)
        Text(value, style = MaterialTheme.typography.titleMedium, color = color)
    }
}

/** Time-based greeting; no notification affordance is added. */
private fun greeting(): String {
    val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
    return when (hour) {
        in 0..5 -> "夜深了"
        in 6..8 -> "早上好"
        in 9..11 -> "上午好"
        in 12..13 -> "中午好"
        in 14..18 -> "下午好"
        else -> "晚上好"
    }
}

private fun dateSubtitle(): String {
    val now = java.util.Date()
    return java.text.SimpleDateFormat("M月d日 E", java.util.Locale.CHINA).format(now) + " · 今天也要好好记账"
}

private fun shortMonth(label: String): String {
    // "2026年10月概览" -> "本月" fallback keeps hero compact.
    val m = Regex("(\\d+年\\d+月)").find(label)?.groupValues?.get(1)
    return m ?: "本月"
}

/**
 * 首页 Hero 余额大卡（深海蓝纯色 0xFF244D60 + 眼睛显隐 + 真实账户余额细分列表）
 * - 消费 MetaRepository.balances() 解码的真实 items 与 totalBalanceCents。
 * - 绝不硬编码微信 1/3 或银行卡分摊，绝不在客户端重算总额。
 * - 隐私开关同时遮蔽总额与全部账户子项。
 * - 区分初次加载、初次失败、刷新中及旧值刷新失败。
 */
@Composable
private fun FinanceHeroBalanceCard(
    state: DashboardBalancesViewState,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var hideBalance by remember { mutableStateOf(false) }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF244D60)),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Header Row: 标题 + 状态/旧值提示 + 眼睛显隐按钮
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "账户总余额",
                        color = Color(0xFFD8E5E9),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    if (state.isRefreshing) {
                        Text(
                            "正在更新...",
                            color = Color(0xFFD8E5E9).copy(alpha = 0.7f),
                            fontSize = 11.sp,
                        )
                    } else if (state.isStale && state.error != null) {
                        Text(
                            "保留旧值",
                            color = Color(0xFFFF8A80),
                            fontSize = 11.sp,
                        )
                    }
                }
                IconButton(
                    onClick = { hideBalance = !hideBalance },
                    modifier = Modifier.size(24.dp),
                ) {
                    FinanceEyeToggleIcon(
                        hidden = hideBalance,
                        tint = Color(0xFFD8E5E9),
                    )
                }
            }

            if (state.isInitialLoading) {
                // 初次加载中状态：诚实展示加载进度，不伪造 0.00
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(
                        color = Color.White,
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp,
                    )
                    Text(
                        "正在读取账户余额...",
                        color = Color(0xFFD8E5E9),
                        fontSize = 12.sp,
                    )
                }
            } else if (state.snapshot == null && state.error != null) {
                // 初次加载失败状态：诚实提示错误与独立重试入口，不伪造 0.00
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "账户余额加载失败：${state.error}",
                        color = Color(0xFFFF8A80),
                        fontSize = 13.sp,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        JzGhostButton(
                            text = "重试余额",
                            onClick = onRetry,
                        )
                    }
                }
            } else if (state.snapshot != null) {
                val snapshot = state.snapshot
                val isNegative = snapshot.totalBalanceCents < 0
                val totalColor = if (!hideBalance && isNegative) Color(0xFFFF8A80) else Color.White

                Text(
                    text = DashboardBalancesHelper.formatAmount(snapshot.totalBalanceCents, hideBalance),
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    color = totalColor,
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "所有账户 (${snapshot.items.size})",
                        color = Color(0xFFD8E5E9).copy(alpha = 0.75f),
                        fontSize = 11.sp,
                    )
                    if (state.isStale && state.error != null) {
                        Text(
                            text = "重试",
                            color = Color(0xFFFF8A80),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .clickable(onClick = onRetry)
                                .padding(horizontal = 4.dp, vertical = 2.dp),
                        )
                    }
                }

                Spacer(Modifier.height(2.dp))
                HorizontalDivider(
                    color = Color.White.copy(alpha = 0.15f),
                    thickness = 1.dp,
                )
                Spacer(Modifier.height(2.dp))

                if (snapshot.items.isEmpty()) {
                    Text(
                        text = "暂无账户数据",
                        color = Color(0xFFD8E5E9).copy(alpha = 0.7f),
                        fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                } else {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        snapshot.items.forEach { item ->
                            val itemNegative = item.balanceCents < 0
                            val itemColor = if (!hideBalance && itemNegative) Color(0xFFFF8A80) else Color(0xFFD8E5E9)
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = item.name,
                                    color = Color(0xFFD8E5E9),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Normal,
                                    modifier = Modifier.weight(1f, fill = false).padding(end = 8.dp),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = DashboardBalancesHelper.formatAmount(item.balanceCents, hideBalance),
                                    color = itemColor,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                    fontFamily = FontFamily.Monospace,
                                )
                            }
                        }
                    }
                }

                if (state.isStale && state.error != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = "余额更新失败：${state.error}，当前保留上次结果",
                        color = Color(0xFFFF8A80),
                        fontSize = 11.sp,
                    )
                }
            }
        }
    }
}

/** Mini bars from server trend values only; empty shows placeholder text. */
@Composable
private fun DashboardMiniBars(incomeCents: Long?, netExpenseCents: Long?) {
    val t = LocalWebTokens.current
    if (incomeCents == null || netExpenseCents == null) {
        Text("暂无数据", style = MaterialTheme.typography.bodySmall, color = t.muted)
        return
    }
    val max = maxOf(incomeCents, netExpenseCents, 1L).toFloat()
    Row(
        modifier = Modifier.fillMaxWidth().height(48.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Box(
            modifier = Modifier.weight(incomeCents.coerceAtLeast(1L).toFloat() / max + 0.2f)
                .height((18 + 20 * incomeCents.toFloat() / max).dp)
                .background(t.ok.copy(alpha = 0.5f), RoundedCornerShape(4.dp)),
        )
        Box(
            modifier = Modifier.weight(netExpenseCents.coerceAtLeast(1L).toFloat() / max + 0.2f)
                .height((18 + 20 * netExpenseCents.toFloat() / max).dp)
                .background(t.danger.copy(alpha = 0.5f), RoundedCornerShape(4.dp)),
        )
        Box(
            modifier = Modifier.weight(0.5f).height(18.dp)
                .background(t.accentSubtle, RoundedCornerShape(4.dp)),
        )
    }
}
