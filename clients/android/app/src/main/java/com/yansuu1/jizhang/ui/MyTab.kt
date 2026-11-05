package com.yansuu1.jizhang.ui

import android.content.Context
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.EventRepeat
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.PendingActions
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.repo.AuthRepository
import com.yansuu1.jizhang.ui.theme.AccentPreset
import com.yansuu1.jizhang.ui.theme.ThemePreference
import com.yansuu1.jizhang.ui.theme.LocalWebTokens
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll

/** 伪 section key：AI 助手由 MainShell 承载为二级页，这里只上报入口，不切 section。 */
private const val ASSISTANT_ENTRY = "assistant_entry"

private val THEME_KEY = stringPreferencesKey("theme_preference")
private val ACCENT_KEY = stringPreferencesKey("accent_preset")

/**
 * 我的 tab (A2+A7+A10): settings hub. Mirrors web `SettingsView` + `DataView` entry
 * points: each section swaps inline (single-activity shell, no deep-link router).
 * 高频记账能力在“记账与计划”组；物品、AI 助手、AI 接口设置、桌面图标与外观、旧理财明细
 * 收进“更多工具”组，全部保持可达。
 *
 * NOTE: AI 聊天是 MainShell 的二级页，由本页“更多工具 → AI 助手”进入并回到本页。
 */
@Composable
fun MyTab(
    api: ApiClient,
    auth: AuthRepository? = null,
    theme: ThemePreference,
    accent: AccentPreset,
    onTheme: (ThemePreference) -> Unit,
    onAccent: (AccentPreset) -> Unit,
    reduceMotion: Boolean = false,
    onReduceMotion: (Boolean) -> Unit = {},
    initialSection: String? = null,
    onAuthExpired: () -> Unit,
    onLoggedOut: () -> Unit = {},
    onSubpageChange: (Boolean) -> Unit = {},
    onOpenAssistant: () -> Unit = {},
    refreshToken: Long = 0L,
    onDataChanged: () -> Unit = {},
    onRegisterNavigation: ((ActiveNavigationHandlers?) -> Unit)? = null,
) {
    var section by remember { mutableStateOf("home") }
    var showingTemplateRepairFromSalary by remember { mutableStateOf(false) }
    var salaryTemplateRefreshToken by remember { mutableStateOf(0) }
    var dataNavigationHandlers by remember { mutableStateOf<ActiveNavigationHandlers?>(null) }
    val context = LocalContext.current
    var hasLegacyPending by remember { mutableStateOf(false) }
    LaunchedEffect(auth?.sessionKey) {
        val user = auth?.user
        if (user?.id != null) {
            val server = api.getBaseUrl()
            hasLegacyPending = OperationReplayStore(context).hasLegacyRecords(server, user.username) ||
                (server != null && com.yansuu1.jizhang.ui.feature.assistant.SharedPreferencesAssistantBatchRecoveryStore(context)
                    .hasLegacyRecords(server, user.username))
        }
    }

    DisposableEffect(section, dataNavigationHandlers) {
        if (section == "data" && dataNavigationHandlers != null) {
            onRegisterNavigation?.invoke(dataNavigationHandlers)
        } else {
            onRegisterNavigation?.invoke(null)
        }
        onDispose { onRegisterNavigation?.invoke(null) }
    }
    fun closeSalaryTemplateRepair() {
        showingTemplateRepairFromSalary = false
        salaryTemplateRefreshToken++
    }
    fun closeSection() {
        section = "home"
        onSubpageChange(false)
    }
    fun openSection(key: String) {
        if (key == ASSISTANT_ENTRY) {
            // AI 助手由 MainShell 承载为二级页（自带来源页与返回），这里只上报入口。
            onOpenAssistant()
            return
        }
        section = key
        onSubpageChange(true)
    }
    LaunchedEffect(initialSection) {
        if (initialSection != null) openSection(initialSection)
    }
    BackHandler(section != "home" || showingTemplateRepairFromSalary) {
        if (showingTemplateRepairFromSalary) closeSalaryTemplateRepair() else closeSection()
    }
    if (section != "home") {
        Column(Modifier.fillMaxSize()) {
            if (section != "salary") {
                Row(
                    modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { closeSection() }) {
                        Icon(
                            imageVector = Icons.Filled.ArrowBack,
                            contentDescription = "返回我的",
                        )
                    }
                    Text(sectionTitle(section), style = MaterialTheme.typography.titleLarge)
                }
            }
            when (section) {
                "invitations" -> InvitationManagementScreen(api, auth?.user, onAuthExpired)
                "financial_plan" -> FinancialHostScreen(
                    api = api,
                    onAuthExpired = onAuthExpired,
                    initialTab = FinancialHostTab.EXECUTION,
                    onNewSalary = { openSection("salary") },
                    onTemplates = { openSection("templates") },
                    onBack = { closeSection() },
                    refreshToken = refreshToken,
                    onDataChanged = onDataChanged,
                )
                "manage" -> ManageTab(api = api, onAuthExpired = onAuthExpired)
                "templates" -> TemplatesTab(api = api, onAuthExpired = onAuthExpired)
                "recurring" -> RecurringRulesTab(api = api, onAuthExpired = onAuthExpired)
                "transfers" -> TransfersTab(api = api, onAuthExpired = onAuthExpired)
                "trash" -> TrashTab(api = api, onAuthExpired = onAuthExpired)
                "data" -> DataTab(
                    api = api,
                    onAuthExpired = onAuthExpired,
                    onDataChanged = onDataChanged,
                    onRegisterNavigation = { dataNavigationHandlers = it },
                )
                "items" -> ItemsTab(api = api, onAuthExpired = onAuthExpired)
                "provider" -> ProviderSettings(api = api, onAuthExpired = onAuthExpired)
                "pending" -> PendingTab(api = api, onAuthExpired = onAuthExpired)
                "salary" -> SalarySheet(
                    api = api,
                    onAuthExpired = onAuthExpired,
                    onSaved = onDataChanged,
                    onPlanConfirmed = onDataChanged,
                    onClose = { closeSection() },
                    onRepairTemplates = { showingTemplateRepairFromSalary = true },
                    templateRefreshToken = salaryTemplateRefreshToken,
                    backEnabled = !showingTemplateRepairFromSalary,
                )
                "settings" -> SettingsFull(
                    api = api,
                    auth = auth,
                    theme = theme,
                    accent = accent,
                    onTheme = onTheme,
                    onAccent = onAccent,
                    reduceMotion = reduceMotion,
                    onReduceMotion = onReduceMotion,
                    onLoggedOut = onLoggedOut,
                )
            }
            if (showingTemplateRepairFromSalary) {
                Dialog(
                    onDismissRequest = { closeSalaryTemplateRepair() },
                    properties = DialogProperties(
                        usePlatformDefaultWidth = false,
                        dismissOnBackPress = false,
                        dismissOnClickOutside = false,
                    ),
                ) {
                    Surface(modifier = Modifier.fillMaxSize(), color = LocalWebTokens.current.bg) {
                        Column(Modifier.fillMaxSize()) {
                            Row(
                                modifier = Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                IconButton(onClick = { closeSalaryTemplateRepair() }, modifier = Modifier.size(48.dp)) {
                                    Icon(Icons.Filled.ArrowBack, contentDescription = "返回工资记录")
                                }
                                Text("修复分配模板", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                            }
                            HorizontalDivider(color = LocalWebTokens.current.border)
                            TemplatesTab(api = api, onAuthExpired = onAuthExpired)
                        }
                    }
                }
            }
        }
        return
    }
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Profile & User Header (1:1 复刻设计图：右上角齿轮 + 圆形可爱头像 + 记账用户 + 管理个人设置)
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "我的",
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                    color = LocalWebTokens.current.fg,
                )
                IconButton(
                    onClick = { openSection("settings") },
                    modifier = Modifier.size(36.dp),
                ) {
                    Icon(
                        Icons.Filled.Settings,
                        contentDescription = "设置",
                        tint = LocalWebTokens.current.fg,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            FinanceCard(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 18.dp,
                contentPadding = 16.dp,
                onClick = { openSection("settings") },
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    FinanceUserAvatar(
                        name = auth?.username?.ifBlank { "记账用户" } ?: "记账用户",
                        sizeDp = 52.dp,
                    )
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            auth?.username?.ifBlank { "记账用户" } ?: "记账用户",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = LocalWebTokens.current.fg,
                        )
                        Text(
                            "管理个人设置",
                            style = MaterialTheme.typography.bodySmall,
                            color = LocalWebTokens.current.muted,
                        )
                    }
                    Text("›", style = MaterialTheme.typography.titleLarge, color = LocalWebTokens.current.muted)
                }
            }
            SettingsGroup(
                title = "记账与计划",
                links = listOf(
                    SettingLink("manage", "分类与账户", "管理分类、账户和标签", Icons.Filled.Category, Color(0xFF4B7682)),
                    SettingLink("salary", "工资记录", "查看工资与分配", Icons.Filled.AccountBalanceWallet, Color(0xFF4B7682)),
                    SettingLink("recurring", "周期账单", "管理自动生成的待确认规则", Icons.Filled.EventRepeat, Color(0xFF4B7682)),
                    SettingLink("pending", "待确认账单", "核对周期规则生成的账单", Icons.Filled.PendingActions, Color(0xFF4B7682)),
                    SettingLink("transfers", "转账记录", "查看账户间转账记录", Icons.Filled.SwapHoriz, Color(0xFF4B7682)),
                    SettingLink("trash", "回收站", "恢复或彻底删除账单", Icons.Filled.DeleteOutline, Color(0xFF4B7682)),
                    SettingLink("data", "数据管理", "导入、导出与服务端备份", Icons.Filled.Storage, Color(0xFF4B7682)),
                ),
                onSelect = { openSection(it) },
            )
            if (auth?.user?.canManageInvitations == true) {
                SettingsGroup(
                    title = "账号管理",
                    links = listOf(SettingLink("invitations", "邀请码管理", "邀请新用户，账本各自独立", Icons.Filled.Description)),
                    onSelect = { openSection(it) },
                )
            }
            if (hasLegacyPending) {
                Text("本机保留了旧版本按用户名保存的待确认操作。升级后不会自动重放，请先核对服务器记录，再联系维护者恢复。",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            SettingsGroup(
                title = "更多工具",
                links = listOf(
                    SettingLink("items", "物品资产", "查看物品、照片与使用成本", Icons.Filled.Inventory2, Color(0xFF4B7682)),
                    SettingLink(ASSISTANT_ENTRY, "AI 助手", "对话、导入预览与智能整理", Icons.Filled.SmartToy, Color(0xFF4B7682)),
                    SettingLink("provider", "AI 接口设置", "管理模型与连接配置", Icons.Filled.Tune, Color(0xFF4B7682)),
                    SettingLink("templates", "分配模板", "设置工资分配比例（低频工具）", Icons.Filled.Description, Color(0xFF4B7682)),
                    SettingLink("settings", "桌面图标与外观", "桌面图标、主题、周期起点和密码", Icons.Filled.Settings, Color(0xFF4B7682)),
                    SettingLink("financial_plan", "四账户理财计划", "四用途明细与测算（也可从底部“计划”进入）", Icons.Filled.AccountBalanceWallet, Color(0xFF4B7682)),
                ),
                onSelect = { openSection(it) },
            )
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, LocalWebTokens.current.border),
            ) {
                SettingsTab(auth = auth, onLogout = onLoggedOut)
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

private data class SettingLink(
    val key: String,
    val title: String,
    val subtitle: String,
    val icon: ImageVector,
    val color: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color(0xFF2D68FF),
)

@Composable
private fun SettingsGroup(title: String, links: List<SettingLink>, onSelect: (String) -> Unit) {
    val tokens = LocalWebTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
            color = tokens.fg,
        )
        FinanceCard(
            modifier = Modifier.fillMaxWidth(),
            cornerRadius = 18.dp,
            contentPadding = 0.dp,
        ) {
            Column {
                links.forEachIndexed { index, link ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp)
                            .clickable { onSelect(link.key) }
                            .padding(horizontal = 14.dp),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(
                            modifier = Modifier.size(32.dp).background(link.color.copy(alpha = 0.12f), CircleShape),
                            contentAlignment = androidx.compose.ui.Alignment.Center,
                        ) {
                            Icon(link.icon, contentDescription = null, tint = link.color, modifier = Modifier.size(17.dp))
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                link.title,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
                                color = tokens.fg,
                            )
                        }
                        Text("›", style = MaterialTheme.typography.titleMedium, color = tokens.muted)
                    }
                    if (index < links.lastIndex) {
                        HorizontalDivider(
                            modifier = Modifier.padding(start = 58.dp),
                            color = tokens.border.copy(alpha = 0.45f),
                        )
                    }
                }
            }
        }
    }
}

private fun sectionTitle(section: String): String = when (section) {
    "invitations" -> "邀请码管理"
    "manage" -> "分类与账户"
    "templates" -> "分配模板"
    "recurring" -> "周期账单"
    "transfers" -> "转账"
    "trash" -> "回收站"
    "data" -> "数据管理"
    "items" -> "物品资产"
    "assistant" -> "AI 助理"
    "provider" -> "AI 接口设置"
    "pending" -> "待确认账单"
    "salary" -> "工资记录"
    "settings" -> "设置与外观"
    else -> "我的"
}

/** Read persisted theme prefs (called once from MainActivity). */
suspend fun readThemePrefs(context: Context): Pair<ThemePreference, AccentPreset> {
    return try {
        val p = context.appPrefs.data.first()
        val t = runCatching { ThemePreference.valueOf(p[THEME_KEY] ?: "System") }
            .getOrDefault(ThemePreference.System)
        val a = runCatching { AccentPreset.valueOf(p[ACCENT_KEY] ?: "Titanium") }
            .getOrDefault(AccentPreset.Titanium)
        t to a
    } catch (_: Exception) {
        ThemePreference.System to AccentPreset.Titanium
    }
}

/** Persist theme prefs (called from MainActivity callbacks). */
suspend fun writeThemePrefs(context: Context, theme: ThemePreference, accent: AccentPreset) {
    try {
        context.appPrefs.edit {
            it[THEME_KEY] = theme.name
            it[ACCENT_KEY] = accent.name
        }
    } catch (_: Exception) {
    }
}

/** Shared prefs accessor used by ApiClient-adjacent theme storage. */
val Context.appPrefs
    get() = com.yansuu1.jizhang.net.appPrefsOf(this)

/** Convenience: collect-once theme flow for previews/tests. */
fun themeLabels(): List<String> =
    ThemePreference.entries.map { it.label } + AccentPreset.entries.map { it.label }

@Suppress("UNUSED_PARAMETER")
fun consumeScope(scope: kotlinx.coroutines.CoroutineScope, block: () -> Unit = {}) {
    block()
}
