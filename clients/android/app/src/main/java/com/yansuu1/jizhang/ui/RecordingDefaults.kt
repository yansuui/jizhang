package com.yansuu1.jizhang.ui

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.yansuu1.jizhang.net.appPrefsOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import java.security.MessageDigest

/**
 * 记账表单的账户默认值（C1-05 / C1-06）。
 *
 * 只有这一份解析规则，新建账单与退款预填共用，避免“静默换账户”：
 * - 退款：必须沿用原到账账户；原账户已不可用时返回错误，绝不改选其他账户。
 * - 普通记账：上次使用的账户仍可用则沿用，否则选第一个可用账户。
 * - 没有任何可用账户：返回阻断错误，不伪造默认账户。
 */
data class RecordingAccountResult(val accountId: String?, val error: String?)

/** 没有任何可用账户时的阻断提示；保存校验仍会再次拦截，不伪造默认账户。 */
const val NO_ACTIVE_RECORDING_ACCOUNT_ERROR = "请先创建或选择一个账户"

fun resolveRecordingAccount(
    lastAccountId: String?,
    activeAccountIds: List<String>,
    refundAccountId: String?,
): RecordingAccountResult {
    if (refundAccountId != null) {
        // 退款预填：空白或已删除的原账户都算不可用，返回既有错误而不是换一个账户。
        val kept = refundAccountId.takeIf { it.isNotBlank() && it in activeAccountIds }
        return if (kept != null) {
            RecordingAccountResult(kept, null)
        } else {
            RecordingAccountResult(null, TransactionEditorHelper.REFUND_ACCOUNT_UNAVAILABLE_ERROR)
        }
    }
    val remembered = lastAccountId?.takeIf { it.isNotBlank() && it in activeAccountIds }
    if (remembered != null) return RecordingAccountResult(remembered, null)
    val firstActive = activeAccountIds.firstOrNull { it.isNotBlank() }
    return if (firstActive != null) {
        RecordingAccountResult(firstActive, null)
    } else {
        RecordingAccountResult(null, NO_ACTIVE_RECORDING_ACCOUNT_ERROR)
    }
}

/**
 * “上次使用的账户”本地偏好，按 serverBaseUrl + FinancialScope.storageIdentity 隔离。
 * 参数 username 保留旧签名；调用方传入已验证的不可变 ID 命名空间（旧服务器才用用户名）。
 *
 * 现有偏好（主题、首页预算模式、未决理财操作）都没有账户默认值，因此在这里本地实现，
 * 不新增依赖。服务端地址或用户名缺失时既不读也不写，避免把账户记到别的服务器/用户名下。
 */
object RecordingAccountPrefs {
    internal fun keyFor(serverBaseUrl: String?, username: String?): String {
        val server = FinancialPrefs.normalizeServerUrl(serverBaseUrl)
        val user = (username ?: "anonymous").trim()
        val raw = "server=${server.length}:$server|user=${user.length}:$user"
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
        val prefix = if (username?.startsWith("id:") == true) "recording_account_v2_" else "recording_account_"
        return prefix + digest.joinToString("") { "%02x".format(it) }.take(16)
    }

    suspend fun read(context: Context, serverBaseUrl: String?, username: String?): String? {
        if (serverBaseUrl.isNullOrBlank() || username.isNullOrBlank()) return null
        return try {
            val key = stringPreferencesKey(keyFor(serverBaseUrl, username))
            appPrefsOf(context).data.first()[key]?.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    suspend fun write(context: Context, serverBaseUrl: String?, username: String?, accountId: String) {
        if (serverBaseUrl.isNullOrBlank() || username.isNullOrBlank() || accountId.isBlank()) return
        try {
            val key = stringPreferencesKey(keyFor(serverBaseUrl, username))
            appPrefsOf(context).edit { it[key] = accountId }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            // 记住账户失败不能阻断记账；下次只是回到“第一个可用账户”的默认值。
        }
    }
}
