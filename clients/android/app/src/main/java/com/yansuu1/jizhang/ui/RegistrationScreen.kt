package com.yansuu1.jizhang.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.yansuu1.jizhang.repo.AuthRepository
import com.yansuu1.jizhang.repo.RegistrationDraft
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun RegistrationScreen(auth: AuthRepository, serverAddress: String, onBack: () -> Unit, onRegistered: () -> Unit) {
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var showsPassword by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    BackHandler { if (!busy) onBack() }
    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(onClick = onBack, enabled = !busy) { Text("‹ 返回登录") }
        Text("邀请码注册", style = MaterialTheme.typography.headlineMedium)
        Text("开启自己的账本，账单、AI 对话和配置各自独立。", style = MaterialTheme.typography.bodyMedium)
        Text(serverAddress, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(code, { code = it }, label = { Text("邀请码") }, singleLine = true,
            enabled = !busy, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(username, { username = it }, label = { Text("账号") }, singleLine = true,
            enabled = !busy, modifier = Modifier.fillMaxWidth(),
            supportingText = { Text("3–64 位英文字母、数字、点、下划线或短横线") })
        OutlinedTextField(password, { password = it }, label = { Text("密码") }, singleLine = true,
            enabled = !busy, modifier = Modifier.fillMaxWidth(),
            visualTransformation = if (showsPassword) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            supportingText = { Text("8–128 位，密码不会保存在设备上") })
        OutlinedTextField(confirmation, { confirmation = it }, label = { Text("再次输入密码") }, singleLine = true,
            enabled = !busy, modifier = Modifier.fillMaxWidth(),
            visualTransformation = if (showsPassword) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Checkbox(showsPassword, { showsPassword = it }, enabled = !busy)
            Text("显示密码", modifier = Modifier.padding(top = 12.dp))
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        JzPrimaryButton(
            text = if (busy) "正在创建账本…" else "注册并登录",
            enabled = !busy && username.isNotBlank() && password.isNotEmpty() && confirmation.isNotEmpty() && code.isNotBlank(),
            onClick = {
                if (!busy) {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            if (auth.register(RegistrationDraft(username, password, confirmation, code))) {
                                password = ""; confirmation = ""; code = ""
                                onRegistered()
                            } else { error = auth.lastError ?: "注册失败，请重试。" }
                        } catch (cancelled: CancellationException) { throw cancelled }
                        finally { busy = false }
                    }
                }
            },
        )
        Text("邀请码仅限使用一次。如果注册后网络中断，可返回登录页使用刚设置的账号和密码登录。",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
