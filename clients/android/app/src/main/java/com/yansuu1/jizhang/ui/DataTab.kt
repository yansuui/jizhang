package com.yansuu1.jizhang.ui

import android.content.Context
import android.net.Uri
import android.os.Environment
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.PortabilityRepository
import com.yansuu1.jizhang.ui.feature.imports.PlatformImportEntryContext
import com.yansuu1.jizhang.ui.feature.imports.PlatformImportHost
import com.yansuu1.jizhang.ui.feature.imports.PlatformImportSource
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Restore guidance stays server-specific; the client never replaces the database. */
private const val RESTORE_GUIDANCE =
    "请按服务器部署文档中的恢复步骤操作，并确保使用运行中服务的 Compose 项目、环境配置和原数据卷。" +
        "多用户服务需区分当前账号账本恢复与全站恢复，不能将个人账本快照替换身份库。" +
        "恢复前先备份并核对目标账号与快照；恢复后检查 /api/v1/health 和对应账本数据。"

/**
 * 数据导出与备份 (A8). Mirrors web `DataView.vue` four cards:
 * export / app-CSV import / platform bills / backups.
 */
@Composable
fun DataTab(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onDataChanged: () -> Unit = {},
    onRegisterNavigation: ((ActiveNavigationHandlers?) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val repo = remember(api) { PortabilityRepository(api) }
    var backups by remember { mutableStateOf(listOf<JSONObject>()) }
    var loadingBackups by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var importResult by remember { mutableStateOf<String?>(null) }
    var importMode by remember { mutableStateOf("transactions") }
    var chosenName by remember { mutableStateOf<String?>(null) }
    var chosenText by remember { mutableStateOf<String?>(null) }
    var platformOpen by remember { mutableStateOf(false) }
    var lastPlatform by remember { mutableStateOf<String?>(null) }
    var exportMsg by remember { mutableStateOf<String?>(null) }
    var exporting by remember { mutableStateOf("transactions") }
    val exportPicker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri: Uri? ->
        if (uri != null) scope.launch {
            busy = true
            try {
                val bytes = repo.downloadExport(exporting)
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                        ?: throw IllegalArgumentException("无法写入所选文件")
                }
                exportMsg = "CSV 已保存到所选位置"
            } catch (e: AuthExpiredException) { onAuthExpired() }
            catch (e: Exception) { error = e.message } finally { busy = false }
        }
    }

    suspend fun reloadBackups() {
        loadingBackups = true
        try {
            val res = repo.listBackups()
            val arr = res.optJSONArray("items")
            val list = mutableListOf<JSONObject>()
            for (i in 0 until (arr?.length() ?: 0)) list.add(arr!!.optJSONObject(i))
            backups = list
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            error = e.message
        } finally {
            loadingBackups = false
        }
    }

    LaunchedEffect(Unit) {
        reloadBackups()
    }

    val csvPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri: Uri? ->
        if (uri == null) {
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            chosenName = null
            chosenText = null
            importResult = null
            try {
                val file = readDocument(context, uri, MAX_CSV_DOCUMENT_BYTES)
                validateCsvDocument(file)
                chosenText = file.bytes.toString(Charsets.UTF_8)
                chosenName = file.name
                error = null
            } catch (e: Exception) { error = e.message }
        }
    }

    if (platformOpen) {
        PlatformImportHost(
            api = api,
            entryContext = PlatformImportEntryContext(source = PlatformImportSource.DATA),
            onAuthExpired = onAuthExpired,
            onClose = { platformOpen = false },
            onImportFinished = { result ->
                onDataChanged()
                lastPlatform = "导入成功：新增 ${result.inserted} 笔账单 (共选 ${result.selected} 笔)"
                platformOpen = false
            },
            onRegisterNavigation = onRegisterNavigation,
        )
        return
    }

    Column(
        Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("数据导出与备份", style = MaterialTheme.typography.headlineSmall)
        Text(
            "导出为本应用 CSV；备份为服务端数据库快照，不提供客户端恢复或下载接口。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        JzCard(Modifier.fillMaxWidth()) {
        Text("导出", style = MaterialTheme.typography.titleSmall)
        Text("下载 CSV，可直接用 Excel 打开（中文不会乱码）。", style = MaterialTheme.typography.bodySmall)
        for ((what, label) in listOf(
            "transactions" to "导出账单",
            "salaries" to "导出工资记录",
            "recurring" to "导出周期账单规则",
            "transfers" to "导出转账",
        )) {
            OutlinedButton(
                onClick = {
                    exporting = what
                    exportPicker.launch("$what.csv")
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(label) }
        }
        if (exportMsg != null) {
            Text(exportMsg!!, style = MaterialTheme.typography.bodySmall)
        }
        }

        JzCard(Modifier.fillMaxWidth()) {
        Text("导入数据", style = MaterialTheme.typography.titleSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    importMode = "transactions"
                    chosenName = null
                    chosenText = null
                    importResult = null
                },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text(if (importMode == "transactions") "● 本应用账单" else "本应用账单") }
            OutlinedButton(
                onClick = {
                    importMode = "transfers"
                    chosenName = null
                    chosenText = null
                    importResult = null
                },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text(if (importMode == "transfers") "● 转账" else "转账") }
        }
        Text("只支持导入本应用导出的 CSV；解析失败会保留所选文件并提示错误。相同 id 会跳过。", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(
            // Some providers classify exported CSV as text/plain or octet-stream.
            onClick = { csvPicker.launch("*/*") },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("选择 CSV 文件") }
        if (chosenName != null) {
            Text("已选择 $chosenName", style = MaterialTheme.typography.bodySmall)
            Button(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        try {
                            val res = if (importMode == "transfers") {
                                repo.importTransfersCsv(chosenText.orEmpty())
                            } else {
                                repo.importTransactionsCsv(chosenText.orEmpty())
                            }
                            val inserted = res.requireImportCount("inserted")
                            val skipped = res.requireImportCount("skipped")
                            val total = res.requireImportCount("total")
                            importResult = "导入完成：新增 $inserted 条，跳过 $skipped 条，共读取 $total 条。"
                            onDataChanged()
                        } catch (e: Exception) {
                            error = e.message
                        } finally {
                            busy = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).imePadding(),
            ) { Text(if (busy) "导入中…" else "确认导入") }
        }
        if (importResult != null) {
            Text(importResult!!, color = MaterialTheme.colorScheme.primary)
        }
        }

        JzCard(Modifier.fillMaxWidth()) {
        Text("微信 / 支付宝账单", style = MaterialTheme.typography.titleSmall)
        Text("上传平台导出文件（微信 .xlsx / 支付宝 GBK CSV）。先预览去重与分类，再逐行选择并导入。", style = MaterialTheme.typography.bodySmall)
        Button(
            onClick = { platformOpen = true },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("打开导入面板") }
        if (lastPlatform != null) {
            Text(lastPlatform!!, color = MaterialTheme.colorScheme.primary)
        }
        }

        JzCard(Modifier.fillMaxWidth()) {
        Text("备份", style = MaterialTheme.typography.titleSmall)
        Text("多用户服务的备份只包含当前账号账本；全站恢复由管理员在服务器操作。导出文件用于查看与迁移。", style = MaterialTheme.typography.bodySmall)
        Button(
            enabled = !busy,
            onClick = {
                scope.launch {
                    busy = true
                    try {
                        repo.createBackup()
                        reloadBackups()
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text(if (busy) "处理中…" else "立即备份") }
        if (loadingBackups) {
            Text("加载中…", style = MaterialTheme.typography.bodySmall)
        } else if (backups.isEmpty()) {
            Text("还没有备份。点上面的按钮创建第一个。", style = MaterialTheme.typography.bodySmall)
        } else {
            for (f in backups) {
                Text(
                    "${f.optString("fileName")} · ${sizeLabel(f.optLong("sizeBytes"))} · ${whenLabel(f.optLong("createdAtMs"))}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        Text("如何恢复备份", style = MaterialTheme.typography.titleSmall)
        Text(
            "数据库恢复需要在服务器上操作，本页面不会直接替换数据库：",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(RESTORE_GUIDANCE, style = MaterialTheme.typography.bodySmall)
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
        }
        }
    }
}

private fun JSONObject.requireImportCount(fieldName: String): Int {
    val raw = opt(fieldName) as? Number
        ?: throw IllegalStateException("服务器未返回可核对的导入结果，请刷新账本确认。")
    val value = raw.toDouble()
    require(value.isFinite() && value >= 0.0 && value <= Int.MAX_VALUE.toDouble() && value % 1.0 == 0.0) {
        "服务器未返回可核对的导入结果，请刷新账本确认。"
    }
    return value.toInt()
}

private fun saveToDownloads(context: Context, name: String, bytes: ByteArray): File {
    val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
    val file = File(dir, name)
    FileOutputStream(file).use { it.write(bytes) }
    return file
}

private fun sizeLabel(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    if (bytes < 1024 * 1024) return "${bytes / 1024} KB"
    return "%.1f MB".format(bytes / (1024.0 * 1024.0))
}

private fun whenLabel(epochMs: Long): String {
    val d = Date(epochMs)
    return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(d)
}

/**
 * 平台账单导入面板 (A8). Mirrors web `PlatformImportModal`:
 * pick file → dry-run preview → check → per-row category override → confirm.
 * Bytes go up verbatim; GBK/xlsx decode + dedupe stay server-side (PRD R5).
 */
@Composable
fun PlatformImportSheet(
    api: ApiClient,
    onAuthExpired: () -> Unit,
    onFinished: (String) -> Unit,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val repo = remember(api) { PortabilityRepository(api) }
    var fileName by remember { mutableStateOf<String?>(null) }
    var fileBytes by remember { mutableStateOf<ByteArray?>(null) }
    var rows by remember { mutableStateOf(listOf<JSONObject>()) }
    var source by remember { mutableStateOf("auto") }
    var checked by remember { mutableStateOf(setOf<String>()) }
    var overrides by remember { mutableStateOf(mapOf<String, String>()) }
    var overrideRow by remember { mutableStateOf<JSONObject?>(null) }
    var overrideText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var detected by remember { mutableStateOf<String?>(null) }

    suspend fun doPreview() {
        val bytes = fileBytes ?: return
        busy = true
        error = null
        try {
            val res = repo.importPlatformBills(bytes, source, true, fileName)
            detected = res.optString("source")
            val arr = res.optJSONArray("rows")
            val list = mutableListOf<JSONObject>()
            for (i in 0 until (arr?.length() ?: 0)) list.add(arr!!.optJSONObject(i))
            rows = list
            checked = list.filter {
                !it.optBoolean("alreadyExists") && !it.optBoolean("ignored") &&
                    !it.optBoolean("possibleDuplicate")
            }.map { it.optString("id") }.toSet()
        } catch (e: AuthExpiredException) {
            onAuthExpired()
        } catch (e: Exception) {
            error = e.message
        } finally {
            busy = false
        }
    }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                val file = readDocument(context, uri)
                fileBytes = file.bytes; fileName = file.name
                rows = emptyList(); checked = emptySet(); overrides = emptyMap()
                doPreview()
            } catch (e: Exception) { error = e.message }
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("微信 / 支付宝导入", style = MaterialTheme.typography.headlineSmall)
        Text(
            "服务端解码后先预览，再逐行勾选与修改分类；确认后才真正入账。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { picker.launch("*/*") },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text("选择文件") }
            OutlinedButton(
                onClick = onClose,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text("关闭") }
        }
        if (fileName != null) {
            Text("已选择 $fileName" + if (detected != null) "（识别为$detected）" else "")
        }
        if (busy) {
            Text("正在处理平台账单…", style = MaterialTheme.typography.bodyMedium)
        }
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
        }
        if (rows.isEmpty()) {
            JzCard(Modifier.fillMaxWidth()) {
                Text("尚未预览平台账单", style = MaterialTheme.typography.titleSmall)
                Text("选择微信 .xlsx 或支付宝 GBK CSV 后会在这里列出待导入行。", style = MaterialTheme.typography.bodySmall)
            }
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(rows, key = { it.optString("id") }) { r ->
                val id = r.optString("id")
                val locked = r.optBoolean("alreadyExists") || r.optBoolean("ignored")
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Checkbox(
                        checked = id in checked,
                        enabled = !locked,
                        onCheckedChange = { on ->
                            checked = if (on) checked + id else checked - id
                        },
                    )
                    Column(Modifier.weight(1f)) {
                        Text(r.optString("note").ifEmpty { r.optString("counterparty") })
                        Text(
                            "${r.optString("dateLabel")} · ${formatYuan(r.optLong("amountCents"))} · " +
                                (overrides[id] ?: r.optString("categoryName")) +
                                if (r.optBoolean("alreadyExists")) " · 已入账" else "" +
                                if (r.optBoolean("possibleDuplicate")) " · 可能重复" else "" +
                                if (r.optBoolean("ignored")) " · ${r.optString("ignoreReason")}" else "",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    OutlinedButton(onClick = {
                        overrideRow = r
                        overrideText = overrides[id] ?: r.optString("categoryName")
                    }) { Text("改分类") }
                }
            }
        }
        if (rows.isNotEmpty()) {
            Button(
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                onClick = {
                    scope.launch {
                        busy = true
                        try {
                            val res = repo.importPlatformBills(
                                fileBytes!!,
                                source,
                                false,
                                fileName,
                                checked.toList(),
                                overrides,
                            )
                            val srcLabel = if (res.optString("source") == "wechat") "微信" else "支付宝"
                            onFinished(
                                "上次导入：$srcLabel，新增 ${res.optInt("inserted")} 条，" +
                                    "支出 ${formatYuan(res.optLong("expenseCents"))} 元、" +
                                    "收入 ${formatYuan(res.optLong("incomeCents"))} 元。",
                            )
                        } catch (e: Exception) {
                            error = e.message
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text("确认导入所选（${checked.size}）") }
        }
    }

    if (overrideRow != null) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { overrideRow = null },
            title = { Text("修改分类") },
            text = {
                OutlinedTextField(
                    value = overrideText,
                    onValueChange = { overrideText = it },
                    label = { Text("分类名") },
                    singleLine = true,
                )
            },
            confirmButton = {
                Button(onClick = {
                    val id = overrideRow!!.optString("id")
                    overrides = overrides + (id to overrideText)
                    overrideRow = null
                }) { Text("确定") }
            },
            dismissButton = {
                OutlinedButton(onClick = { overrideRow = null }) { Text("取消") }
            },
        )
    }
}
