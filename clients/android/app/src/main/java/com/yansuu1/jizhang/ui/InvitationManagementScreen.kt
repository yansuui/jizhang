package com.yansuu1.jizhang.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.net.AuthenticatedUser
import com.yansuu1.jizhang.net.authenticationErrorMessage
import com.yansuu1.jizhang.repo.CreatedInvitation
import com.yansuu1.jizhang.repo.Invitation
import com.yansuu1.jizhang.repo.InvitationRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun InvitationManagementScreen(api: ApiClient, user: AuthenticatedUser?, onAuthExpired: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val repository = remember(api) { InvitationRepository(api) }
    var invitations by remember { mutableStateOf<List<Invitation>>(emptyList()) }
    var created by remember { mutableStateOf<CreatedInvitation?>(null) }
    var revoking by remember { mutableStateOf<Invitation?>(null) }
    var busy by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var denied by remember { mutableStateOf(user?.canManageInvitations != true) }
    var error by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }

    fun handleFailure(failure: Exception) {
        if (failure is CancellationException) throw failure
        if (failure is AuthExpiredException) { onAuthExpired(); return }
        if ((failure as? ApiException)?.status == 403) {
            denied = true
            created = null
            invitations = emptyList()
        }
        error = authenticationErrorMessage(failure)
    }

    suspend fun reload() {
        if (busy || denied) return
        busy = true; error = null
        try { invitations = repository.list(); loaded = true }
        catch (failure: Exception) { handleFailure(failure) }
        finally { busy = false }
    }

    LaunchedEffect(user?.id) { reload() }
    DisposableEffect(Unit) { onDispose { created = null } }
    if (denied) {
        Text("当前账号没有管理邀请码的权限。", modifier = Modifier.padding(24.dp))
        return
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("每个邀请码可注册一个账号，7 天后过期。新用户的账本和 AI 配置各自独立。",
                style = MaterialTheme.typography.bodyMedium)
        }
        item {
            JzPrimaryButton(text = "创建邀请码", enabled = !busy && created == null, onClick = {
                if (!busy && created == null) {
                    busy = true; error = null; copied = false
                    scope.launch {
                        try {
                            val response = repository.create()
                            created = response
                            invitations = listOf(response.invitation) + invitations.filter { it.id != response.invitation.id }
                        } catch (failure: Exception) {
                            handleFailure(failure)
                            if (!denied && (failure !is ApiException || failure.status >= 500)) {
                                error = "未能确认创建结果。请刷新列表；如已创建，可撤销后重新生成。"
                            }
                        } finally { busy = false }
                    }
                }
            })
        }
        created?.let { value ->
            item {
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("刚创建的邀请码", style = MaterialTheme.typography.titleMedium)
                        Text(value.code)
                        Text("完整邀请码只显示这一次，请复制给受邀者。", style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = {
                            val clip = ClipData.newPlainText("邀请码", value.code)
                            if (Build.VERSION.SDK_INT >= 33) {
                                clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                            }
                            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
                            copied = true
                        }) { Text(if (copied) "已复制" else "复制邀请码") }
                        TextButton(onClick = { created = null; copied = false }) { Text("已保存，收起邀请码") }
                    }
                }
            }
        }
        item {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("邀请码记录", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                TextButton(onClick = { scope.launch { reload() } }, enabled = !busy) { Text("刷新") }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (loaded && invitations.isEmpty()) Text("还没有邀请码", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(invitations, key = { it.id }) { invitation ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(when (invitation.currentStatus()) { "active" -> "待使用"; "used" -> "已使用"; "expired" -> "已过期"; else -> "已撤销" })
                        if (invitation.currentStatus() == "active") {
                            TextButton(onClick = { revoking = invitation }, enabled = !busy) { Text("撤销") }
                        }
                    }
                    Text("创建于 ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(invitation.createdAt))}", style = MaterialTheme.typography.bodySmall)
                    Text("有效期至 ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(invitation.expiresAt))}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
    revoking?.let { invitation ->
        AlertDialog(
            onDismissRequest = { revoking = null }, title = { Text("撤销这个邀请码？") },
            text = { Text("撤销后将无法用它注册。") },
            confirmButton = { TextButton(onClick = {
                revoking = null
                if (!busy) {
                    busy = true; error = null
                    scope.launch {
                        try {
                            repository.revoke(invitation)
                            invitations = invitations.map { if (it.id == invitation.id) it.copy(status = "revoked") else it }
                            if (created?.invitation?.id == invitation.id) created = null
                        } catch (failure: Exception) { handleFailure(failure) }
                        finally { busy = false }
                    }
                }
            }) { Text("撤销") } },
            dismissButton = { TextButton(onClick = { revoking = null }) { Text("取消") } },
        )
    }
}
