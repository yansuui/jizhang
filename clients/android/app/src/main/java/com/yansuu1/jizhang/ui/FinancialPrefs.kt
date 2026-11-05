package com.yansuu1.jizhang.ui

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.net.AuthenticatedUser
import com.yansuu1.jizhang.net.appPrefsOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.security.MessageDigest

/**
 * 首页预算卡片展示模式：
 * - CATEGORY: 经典分类信封预算（默认）
 * - PURPOSE: 四用途执行规划
 */
enum class HomeBudgetMode(val wire: String, val label: String) {
    CATEGORY("category", "分类信封"),
    PURPOSE("purpose", "四用途执行");

    companion object {
        fun fromWire(value: String?): HomeBudgetMode {
            return entries.firstOrNull { it.wire.equals(value, ignoreCase = true) } ?: CATEGORY
        }
    }
}

data class FinancialScope(
    val serverBaseUrl: String,
    val username: String,
    val userId: String? = null,
) {
    /** New identities use a distinct namespace; never adopt username-only pending writes. */
    val storageIdentity: String get() = userId?.let { "id:$it" } ?: username
    init {
        require(serverBaseUrl.isNotBlank()) { "serverBaseUrl 不能为空" }
        require(username.isNotBlank()) { "username 不能为空，不可使用匿名未认证会话持久化未决操作" }
        require(userId == null || userId.isNotBlank()) { "userId 不能为空" }
    }
}

/**
 * 首页模式与理财规划偏好按 serverBaseUrl + FinancialScope.storageIdentity 隔离。
 * 新服务使用不可变用户 ID；只有未提供 ID 的旧服务器回退用户名。
 */
object FinancialPrefs {

    /**
     * 解析并校验当前已认证的 serverBaseUrl、不可变用户 ID 与显示用户名。
     * 直接在 Dispatchers.IO 上调用 api.get("/api/v1/auth/me")，确保 CancellationException 与 401 正常抛出。
     * 校验前后 baseURL 一致且 session 未过期，严格拒绝匿名与非受信会话。
     */
    suspend fun resolveAuthenticatedScope(api: ApiClient): FinancialScope = withContext(Dispatchers.IO) {
        val requestIdentity = api.captureRequestIdentity()
        val beforeUrl = api.getBaseUrl() ?: throw IllegalStateException("未配置服务端地址")
        val me = api.get("/api/v1/auth/me")
        val afterUrl = api.getBaseUrl() ?: throw IllegalStateException("服务端地址已丢失")
        if (beforeUrl != afterUrl || !api.isCurrent(requestIdentity)) {
            throw IllegalStateException("解析认证上下文期间服务端地址发生变动，已阻断写操作")
        }
        if (api.sessionExpired.value) {
            throw com.yansuu1.jizhang.net.AuthExpiredException("登录会话已过期，已阻断写操作")
        }
        val user = AuthenticatedUser.fromJson(me)
        FinancialScope(serverBaseUrl = afterUrl, username = user.username, userId = user.id)
    }

    suspend fun resolveFinancialScope(api: ApiClient): FinancialScope = resolveAuthenticatedScope(api)

    internal fun normalizeServerUrl(serverBaseUrl: String?): String {
        val raw = serverBaseUrl?.trim()?.trimEnd('/') ?: return "default"
        val parsed = raw.toHttpUrlOrNull() ?: return raw
        // scheme 和 host 自动规范化小写，保留端口与原始 path 大小写
        val portSuffix = if (parsed.port != okhttp3.HttpUrl.defaultPort(parsed.scheme)) ":${parsed.port}" else ""
        val path = parsed.encodedPath.trimEnd('/')
        return "${parsed.scheme.lowercase()}://${parsed.host.lowercase()}$portSuffix$path"
    }

    internal fun prefKeyForUser(serverBaseUrl: String?, username: String?): String {
        val s = normalizeServerUrl(serverBaseUrl)
        val u = (username ?: "anonymous").trim() // 用户名严格保留大小写
        val raw = "server=${s.length}:$s|user=${u.length}:$u"
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(raw.toByteArray(Charsets.UTF_8))
        val hash = digest.joinToString("") { "%02x".format(it) }.take(16)
        val version = if (username?.startsWith("id:") == true) "home_budget_mode_v2_" else "home_budget_mode_"
        return "$version$hash"
    }

    suspend fun readHomeBudgetMode(
        context: Context,
        serverBaseUrl: String?,
        username: String?,
    ): HomeBudgetMode {
        return try {
            val key = stringPreferencesKey(prefKeyForUser(serverBaseUrl, username))
            val raw = appPrefsOf(context).data.first()[key]
            HomeBudgetMode.fromWire(raw)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            HomeBudgetMode.CATEGORY
        }
    }

    suspend fun writeHomeBudgetMode(
        context: Context,
        serverBaseUrl: String?,
        username: String?,
        mode: HomeBudgetMode,
    ) {
        try {
            val key = stringPreferencesKey(prefKeyForUser(serverBaseUrl, username))
            appPrefsOf(context).edit { it[key] = mode.wire }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            // 忽略非取消类的写入失败，避免阻断 UI 交互
        }
    }
}

/**
 * 记录待重放或等待确认的理财操作（在发送网络写请求前本地持久化，供进程重启或网络不明确时恢复）。
 */
data class PendingFinancialOperation(
    val operationId: String,
    val method: String,
    val path: String,
    val payloadJson: String,
    val expectedRevision: Long? = null,
    val createdAt: Long = System.currentTimeMillis(),
) {
    init {
        require(operationId.isNotBlank()) { "operationId 不能为空" }
        require(method.isNotBlank()) { "method 不能为空" }
        require(path.isNotBlank()) { "path 不能为空" }
    }

    fun toJson(): String {
        return JSONObject().apply {
            put("operationId", operationId)
            put("method", method)
            put("path", path)
            put("payloadJson", payloadJson)
            if (expectedRevision != null) put("expectedRevision", expectedRevision)
            put("createdAt", createdAt)
        }.toString()
    }

    companion object {
        fun fromJson(jsonStr: String): PendingFinancialOperation {
            val obj = try {
                JSONObject(jsonStr)
            } catch (e: Exception) {
                // 不在异常信息中打印整个 jsonStr 以防敏感账务信息泄露
                throw IllegalStateException("待重放操作数据不是合法 JSON", e)
            }
            require(obj.has("operationId") && !obj.isNull("operationId")) { "缺少 operationId" }
            val opId = obj.getString("operationId")
            require(opId.isNotBlank()) { "operationId 为空" }

            require(obj.has("method") && !obj.isNull("method")) { "缺少 method" }
            val method = obj.getString("method")
            require(method.isNotBlank()) { "method 为空" }

            require(obj.has("path") && !obj.isNull("path")) { "缺少 path" }
            val path = obj.getString("path")
            require(path.isNotBlank()) { "path 为空" }

            require(obj.has("payloadJson") && !obj.isNull("payloadJson")) { "缺少 payloadJson" }
            val payload = obj.getString("payloadJson")

            val rev = if (obj.has("expectedRevision") && !obj.isNull("expectedRevision")) obj.getLong("expectedRevision") else null
            val created = obj.optLong("createdAt", System.currentTimeMillis())

            return PendingFinancialOperation(
                operationId = opId,
                method = method,
                path = path,
                payloadJson = payload,
                expectedRevision = rev,
                createdAt = created,
            )
        }
    }
}

class OperationReplayStore(context: Context) {
    private val sp = context.getSharedPreferences("financial_operations_replay", Context.MODE_PRIVATE)

    companion object {
        // Callers pass FinancialScope.storageIdentity in the legacy-named username argument.
        // v2 keys are intentionally disjoint from every old op_<hash> key; no automatic migration.
        // 全局单例锁，防止同一应用内多个 Store 实例产生并发盘读写竞争
        private val GLOBAL_LOCK = Any()

        internal fun scopeHash(serverBaseUrl: String?, username: String?): String {
            val s = FinancialPrefs.normalizeServerUrl(serverBaseUrl)
            val u = (username ?: "anonymous").trim()
            val raw = "server=${s.length}:$s|user=${u.length}:$u"
            val md = MessageDigest.getInstance("SHA-256")
            val digest = md.digest(raw.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }.take(16)
        }

        internal fun prefixFor(serverBaseUrl: String?, username: String?): String {
            val version = if (username?.startsWith("id:") == true) "op_v2_" else "op_"
            return "$version${scopeHash(serverBaseUrl, username)}_"
        }

        internal fun keyFor(serverBaseUrl: String?, username: String?, operationId: String): String {
            return "${prefixFor(serverBaseUrl, username)}$operationId"
        }
    }

    fun hasLegacyRecords(serverBaseUrl: String?, username: String): Boolean = synchronized(GLOBAL_LOCK) {
        val oldPrefix = "op_${scopeHash(serverBaseUrl, username)}_"
        sp.all.keys.any { it.startsWith(oldPrefix) }
    }

    suspend fun record(serverBaseUrl: String?, username: String?, op: PendingFinancialOperation) = withContext(Dispatchers.IO) {
        synchronized(GLOBAL_LOCK) {
            val key = keyFor(serverBaseUrl, username, op.operationId)
            val existing = sp.getString(key, null)
            if (existing != null) {
                // 如果已存在损坏数据，显式抛错阻断，防止静默覆盖未知未决
                val decoded = try {
                    PendingFinancialOperation.fromJson(existing)
                } catch (e: Exception) {
                    throw IllegalStateException("发现损坏的待执行未决操作数据，已阻断新操作写入以防丢失：${op.operationId}", e)
                }
                val isIdentical = decoded.operationId == op.operationId &&
                    decoded.method == op.method &&
                    decoded.path == op.path &&
                    decoded.payloadJson == op.payloadJson
                if (!isIdentical) {
                    throw IllegalStateException("不可使用相同 operationId 覆盖不同请求内容/资源路径的未决操作：${op.operationId}")
                }
            }
            val committed = sp.edit().putString(key, op.toJson()).commit()
            check(committed) { "持久化待执行理财操作失败，已阻止请求以防未知网络下丢失幂等依据。" }
        }
    }

    fun get(serverBaseUrl: String?, username: String?, operationId: String): PendingFinancialOperation? = synchronized(GLOBAL_LOCK) {
        val key = keyFor(serverBaseUrl, username, operationId)
        val raw = sp.getString(key, null) ?: return null
        return PendingFinancialOperation.fromJson(raw)
    }

    suspend fun remove(serverBaseUrl: String?, username: String?, operationId: String) = withContext(Dispatchers.IO) {
        synchronized(GLOBAL_LOCK) {
            val key = keyFor(serverBaseUrl, username, operationId)
            val committed = sp.edit().remove(key).commit()
            check(committed) { "移除已提交理财操作记录失败：$operationId" }
        }
    }

    fun list(serverBaseUrl: String?, username: String?): List<PendingFinancialOperation> = synchronized(GLOBAL_LOCK) {
        val prefix = prefixFor(serverBaseUrl, username)
        return sp.all.filterKeys { it.startsWith(prefix) }.values.mapNotNull {
            val json = it as? String ?: return@mapNotNull null
            PendingFinancialOperation.fromJson(json)
        }
    }
}
