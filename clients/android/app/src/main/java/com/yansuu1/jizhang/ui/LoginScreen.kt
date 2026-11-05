package com.yansuu1.jizhang.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.yansuu1.jizhang.R
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.repo.AuthRepository
import kotlinx.coroutines.launch
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff

/**
 * Login screen (A2). Mirrors web `LoginView.vue`, plus the N1 server-URL field:
 * the server address is user-configured + remembered, never hardcoded (PRD R3).
 * Invitations create independent accounts; the original owner is provisioned by CLI.
 */
@Composable
fun LoginScreen(
    api: ApiClient,
    auth: AuthRepository,
    onLoggedIn: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showServerSettings by remember { mutableStateOf(false) }
    var showRegistration by remember { mutableStateOf(false) }
    var savingServer by remember { mutableStateOf(false) }
    var serverError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        // N1: prefill the remembered server address; then check the session
        // (router guard parity: resolve once before deciding where to land).
        serverUrl = api.getBaseUrl().orEmpty()
        var restored = false
        if (api.hasSession()) {
            val refreshed = kotlinx.coroutines.withTimeoutOrNull(12000) { auth.refresh(); true } == true
            restored = refreshed && auth.username != null
        }
        checking = false
        error = auth.lastError
        if (restored) onLoggedIn()
    }

    if (checking) {
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(12.dp))
            Text(
                "正在检查登录状态",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(20.dp))
            CircularProgressIndicator()
        }
        return
    }

    if (showRegistration) {
        RegistrationScreen(
            auth = auth, serverAddress = serverUrl,
            onBack = { showRegistration = false }, onRegistered = onLoggedIn,
        )
        return
    }

    BackHandler(enabled = showServerSettings) {
        if (!savingServer) showServerSettings = false
    }
    if (showServerSettings) {
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp),
        ) {
            TextButton(onClick = { if (!savingServer) showServerSettings = false }, enabled = !savingServer) {
                Text("‹ 返回登录")
            }
            Text("服务地址", style = MaterialTheme.typography.headlineSmall)
            Text(
                "切换服务器会清除旧服务器的登录状态，需要重新登录。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = serverUrl,
                onValueChange = {
                    serverUrl = it
                    serverError = null
                },
                label = { Text("服务器地址") },
                placeholder = { Text("https://example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
                enabled = !savingServer,
                isError = serverError != null,
            )
            OutlinedButton(
                onClick = {
                    serverUrl = ApiClient.DEFAULT_BASE_URL
                    serverError = null
                },
                enabled = !savingServer && serverUrl != ApiClient.DEFAULT_BASE_URL,
            ) { Text("恢复默认地址") }
            serverError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            JzPrimaryButton(
                text = if (savingServer) "保存中…" else "保存服务地址",
                enabled = !savingServer,
                onClick = {
                    scope.launch {
                        val candidate = serverUrl.trim()
                        if (!ApiClient.looksLikeUrl(candidate)) {
                            serverError = "请输入有效的 http(s):// 地址。"
                            return@launch
                        }
                        savingServer = true
                        serverError = null
                        try {
                            api.setBaseUrl(candidate)
                            serverUrl = api.getBaseUrl().orEmpty()
                            showServerSettings = false
                        } catch (e: Exception) {
                            serverError = e.message?.takeIf(String::isNotBlank) ?: "无法保存服务地址，请重试。"
                        } finally {
                            savingServer = false
                        }
                    }
                },
            )
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(32.dp))
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium)
        Text(
            "信封预算法 · 个人账本",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Column(
                Modifier.padding(14.dp),
                verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp),
            ) {
                Text("服务地址", style = MaterialTheme.typography.labelLarge)
                Text(
                    serverUrl.ifBlank { ApiClient.DEFAULT_BASE_URL },
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = { showServerSettings = true }, enabled = !loading) { Text("修改服务地址") }
            }
        }
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            enabled = !loading,
            label = { Text("用户名") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            enabled = !loading,
            label = { Text("密码") },
            singleLine = true,
            visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                    Icon(
                        imageVector = if (passwordVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = if (passwordVisible) "隐藏密码" else "显示密码",
                    )
                }
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(16.dp))
        JzPrimaryButton(
            text = if (loading) "登录中…" else "登录",
            onClick = {
                if (loading) return@JzPrimaryButton
                scope.launch {
                    error = null
                    if (serverUrl.isBlank()) {
                        error = "请先填写服务端地址"
                        return@launch
                    }
                    if (!ApiClient.looksLikeUrl(serverUrl)) {
                        error = "服务端地址须以 http(s):// 开头"
                        return@launch
                    }
                    if (username.trim().isEmpty() || password.isEmpty()) {
                        error = "请填写用户名和密码"
                        return@launch
                    }
                    loading = true
                    try {
                        api.setBaseUrl(serverUrl)
                    } catch (e: IllegalArgumentException) {
                        error = e.message
                        loading = false
                        return@launch
                    }
                    val ok = auth.login(username.trim(), password)
                    loading = false
                    if (ok) onLoggedIn() else error = auth.lastError ?: "登录失败，请重试。"
                }
            },
            enabled = !loading,
        )
        TextButton(onClick = { password = ""; error = null; showRegistration = true }, enabled = !loading) {
            Text("邀请码注册")
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "已有账号直接登录；新用户请向管理员获取邀请码。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
