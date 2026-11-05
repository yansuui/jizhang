package com.yansuu1.jizhang.net

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Network layer N1–N7 (parent design.md §2.1). Single choke point for every
 * `/api/v1/...` call: baseURL config, session cookie, CSRF header, error mapping.
 *
 * Rules enforced here (do NOT re-implement per repository):
 * - N1: baseURL is user-configured + remembered (DataStore), never hardcoded.
 * - N2: session cookie `jizhang_session` persisted via CookieJar; cleared on logout.
 * - N3: every mutating request carries `X-Requested-With: fetch` (login included).
 * - N4: bodiless POST sends NO `Content-Type` (Fastify 400s otherwise).
 * - N5: non-2xx becomes [ApiException] carrying the server `{error:{code,message}}`;
 *   HTTP 401 surfaces as [AuthExpiredException] so UI returns to login.
 * - N6: online-first — callers check [requireOnline] before writes; responses are
 *   never cached (`Cache-Control` is server `no-store`; no OkHttp cache installed).
 * - N7: exports/backups download through [download] with the session cookie;
 *   there is NO restore endpoint (CLI only) — show the command, don't invent one.
 */

private val Context.prefs by preferencesDataStore(name = "jizhang")

/** Shared prefs accessor (theme prefs reuse the same file). */
fun appPrefsOf(context: Context) = context.prefs

/** Thrown for any non-2xx API response. Mirrors web `ApiError{status,code,message}`. */
open class ApiException(
    val status: Int,
    val code: String,
    message: String,
) : Exception(message)

/** HTTP 401: session missing/expired — UI must route to login. Mirrors `isUnauthorized`. */
class AuthExpiredException(message: String = "登录已过期，请重新登录。") :
    ApiException(401, "UNAUTHORIZED", message)

/** Thrown when a write is attempted offline. Mirrors web `OfflineError`. */
class OfflineException(message: String = "需要联网才能记账。") : Exception(message)

/** Raw server-sent event frame parsed from an SSE connection. */
data class SseEvent(
    val id: String? = null,
    val event: String? = null,
    val data: String = "",
)

private val BASE_URL_KEY = stringPreferencesKey("server_base_url")

/** Request shape shared by JSON, raw file uploads and bodiless mutations. */
internal fun apiRequest(method: String, url: HttpUrl, body: okhttp3.RequestBody? = null): Request {
    val builder = Request.Builder().url(url)
    if (method != "GET") builder.header("X-Requested-With", "fetch")
    val actualBody = body ?: if (method in listOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody(null) else null
    return builder.method(method, actualBody).build()
}

class JizhangCookieJar(
    private val read: () -> List<String> = { emptyList() },
    private val write: (List<String>) -> Unit = {},
) : CookieJar {
    private val store = read().mapNotNull { encoded ->
        val parts = encoded.split('\t', limit = 2)
        if (parts.size != 2) null else runCatching { Cookie.parse(parts[0].toHttpUrl(), parts[1]) }.getOrNull()
    }.toMutableList()

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (cookie in cookies) {
            store.removeAll { it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path }
            if (cookie.name == "jizhang_session" && cookie.expiresAt > System.currentTimeMillis()) store.add(cookie)
        }
        persist()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        store.removeAll { it.expiresAt <= System.currentTimeMillis() }
        return store.filter { it.matches(url) }
    }

    @Synchronized
    fun clear() { store.clear(); write(emptyList()) }

    private fun persist() = write(store.map { "${if (it.secure) "https" else "http"}://${it.domain}/\t$it" })
}

class ApiClient(private val context: Context) {
    private val sessionPrefs = context.getSharedPreferences("jizhang_session", Context.MODE_PRIVATE)
    private val cookieJar = JizhangCookieJar(
        read = { sessionPrefs.getStringSet("cookies", emptySet()).orEmpty().toList() },
        write = { sessionPrefs.edit().putStringSet("cookies", it.toSet()).commit(); Unit },
    )
    val sessionExpired = kotlinx.coroutines.flow.MutableStateFlow(false)

    private val owner = ApiRequestOwner(
        runCatching { kotlinx.coroutines.runBlocking { getBaseUrl() } }.getOrNull() ?: DEFAULT_BASE_URL
    )

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(90, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    internal val transport = ApiTransport(
        http = http,
        owner = owner,
        cookieJar = cookieJar,
        onCurrentSessionExpired = {
            sessionExpired.value = true
        },
    )

    internal suspend fun captureRequestIdentity(): ApiRequestIdentity {
        val base = requireBaseUrl()
        val current = owner.capture()
        return if (current.baseUrl != base) {
            owner.advance(base)
        } else {
            current
        }
    }

    internal fun isCurrent(identity: ApiRequestIdentity): Boolean =
        owner.isCurrent(identity)

    internal fun advanceSession(baseUrl: String? = null): ApiRequestIdentity {
        val base = baseUrl ?: (runCatching { kotlinx.coroutines.runBlocking { getBaseUrl() } }.getOrNull() ?: DEFAULT_BASE_URL)
        return owner.advance(base)
    }

    // ── N1: baseURL ──────────────────────────────────────────────────────────
    suspend fun getBaseUrl(): String? =
        context.prefs.data.map { it[BASE_URL_KEY] ?: DEFAULT_BASE_URL }.first()

    suspend fun setBaseUrl(url: String) {
        val parsed = runCatching { url.trim().toHttpUrl() }.getOrNull()
        require(parsed != null && parsed.username.isEmpty() && parsed.password.isEmpty() &&
            parsed.query == null && parsed.fragment == null && parsed.encodedPath == "/") {
            "请填写完整的 http(s):// 服务地址，不含路径、密码或查询参数"
        }
        val normalized = parsed.toString().trimEnd('/')
        if (normalized != getBaseUrl()) clearSession()
        owner.advance(normalized)
        context.prefs.edit { it[BASE_URL_KEY] = normalized }
        sessionExpired.value = false
    }

    private suspend fun requireBaseUrl(): String =
        getBaseUrl() ?: throw IllegalStateException("请先填写服务端地址")

    // ── HTTP verbs ───────────────────────────────────────────────────────────
    suspend fun get(path: String, query: Map<String, String> = emptyMap()): JSONObject =
        call("GET", path, query = query)

    suspend fun post(
        path: String,
        body: JSONObject? = null,
        timeoutMs: Long? = null,
    ): JSONObject = call("POST", path, body = body, timeoutMs = timeoutMs)

    suspend fun patch(path: String, body: JSONObject): JSONObject =
        call("PATCH", path, body = body)

    suspend fun put(path: String, body: JSONObject): JSONObject =
        call("PUT", path, body = body)

    suspend fun delete(path: String, body: JSONObject? = null): JSONObject =
        call("DELETE", path, body = body)

    /** Raw-bytes POST (platform-bill xlsx/GBK, item photos). Body sent verbatim. */
    suspend fun postBytes(path: String, contentType: String, bytes: ByteArray): JSONObject =
        call("POST", path, rawBody = contentType to bytes)

    suspend fun putBytes(path: String, contentType: String, bytes: ByteArray): JSONObject =
        call("PUT", path, rawBody = contentType to bytes)

    /** Raw-text POST (CSV import as `text/csv`). */
    suspend fun postText(path: String, contentType: String, text: String): JSONObject =
        call("POST", path, rawBody = contentType to text.toByteArray(Charsets.UTF_8))

    /** File download with the session cookie (N7). Returns raw bytes; caller saves/shares. */
    suspend fun download(url: String): ByteArray {
        val identity = captureRequestIdentity()
        val base = requireBaseUrl()
        val full = if (url.startsWith("/")) base + url else url
        val req = Request.Builder().url(full).get().build()
        return transport.execute(identity, req) { resp ->
            if (resp.code == 401) throw AuthExpiredException()
            if (!resp.isSuccessful) throw toApiException(resp.code, resp.body?.string().orEmpty())
            resp.body?.bytes() ?: ByteArray(0)
        }
    }

    /**
     * Server-Sent Events primitive with shared session cookies, CSRF header,
     * bounded frame/line limits, strict status & content-type, no redirects,
     * safe Dispatchers.IO execution, and immediate OkHttp Call cancellation on Flow disposal.
     */
    fun streamSse(
        path: String,
        query: Map<String, String> = emptyMap(),
    ): Flow<SseEvent> = flow {
        val identity = captureRequestIdentity()
        val base = requireBaseUrl()
        val urlBuilder = (base + path).toHttpUrl().newBuilder()
        for ((k, v) in query) {
            if (v.isNotEmpty()) urlBuilder.addQueryParameter(k, v)
        }
        val request = Request.Builder()
            .url(urlBuilder.build())
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("X-Requested-With", "fetch")
            .get()
            .build()

        val sseClient = http.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()

        cancellableBlockingFlow<SseEvent>(cancelTransport = { }) { send ->
            transport.execute(identity, request, sseClient) { resp ->
                if (resp.code == 401) {
                    throw AuthExpiredException(readMessage(resp.body?.string().orEmpty()))
                }
                if (resp.code in 300..399) {
                    throw ApiException(resp.code, "SSE_REDIRECT_FORBIDDEN", "SSE 重定向被禁止")
                }
                if (!resp.isSuccessful) {
                    val text = resp.body?.string().orEmpty()
                    throw toApiException(resp.code, text)
                }
                val contentType = resp.header("Content-Type").orEmpty().lowercase()
                val mediaType = contentType.split(";").firstOrNull()?.trim().orEmpty()
                if (mediaType != "text/event-stream") {
                    throw ApiException(resp.code, "INVALID_CONTENT_TYPE", "Expected text/event-stream but received $contentType")
                }
                val body = resp.body ?: return@execute
                val source = body.source()

                SseParser.parse(source) { event -> kotlinx.coroutines.runBlocking { send(event) } }
            }
        }.collect { emit(it) }
    }.flowOn(Dispatchers.IO)

    fun clearSession() {
        cookieJar.clear()
        owner.advance(owner.capture().baseUrl)
    }

    suspend fun hasSession(): Boolean = cookieJar.loadForRequest((requireBaseUrl() + "/api/v1/auth/me").toHttpUrl()).isNotEmpty()

    /** Session cookies as a `Cookie` header value (for the raw PUT uploader). */
    fun currentSessionCookie(): String =
        kotlinx.coroutines.runBlocking { getBaseUrl() }?.let { base ->
            try {
                val url = base.toHttpUrl()
                cookieJar.loadForRequest(url).joinToString("; ") { "${it.name}=${it.value}" }
            } catch (_: Exception) {
                ""
            }
        }.orEmpty()

    // ── internals ────────────────────────────────────────────────────────────
    private suspend fun call(
        method: String,
        path: String,
        query: Map<String, String> = emptyMap(),
        body: JSONObject? = null,
        rawBody: Pair<String, ByteArray>? = null,
        timeoutMs: Long? = null,
    ): JSONObject {
        val identity = captureRequestIdentity()
        val base = requireBaseUrl()
        val urlBuilder = (base + path).toHttpUrl().newBuilder()
        for ((k, v) in query) {
            if (v.isEmpty()) continue
            urlBuilder.addQueryParameter(k, v)
        }
        val requestBody = when {
            rawBody != null -> rawBody.second.toRequestBody(rawBody.first.toMediaType())
            body != null -> body.toString().toRequestBody("application/json".toMediaType())
            else -> null
        }
        val request = apiRequest(method, urlBuilder.build(), requestBody)

        val clientOverride = when {
            timeoutMs != null -> http.newBuilder()
                .callTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                .build()
            path == "/api/v1/auth/me" -> http.newBuilder()
                .callTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            else -> null
        }
        return transport.execute(identity, request, clientOverride) { resp ->
            val text = resp.body?.string().orEmpty()
            val publicAuthentication = method == "POST" && isPublicAuthenticationPath(path)
            if (resp.code == 401 && !publicAuthentication) throw AuthExpiredException(readMessage(text))
            if (!resp.isSuccessful) throw toApiException(resp.code, text)
            val result = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (publicAuthentication) {
                AuthenticatedUser.fromJson(result, requireStableId = path == "/api/v1/auth/register")
            }
            result
        }
    }

    private fun toApiException(status: Int, text: String): ApiException {
        return try {
            val err = JSONObject(text).optJSONObject("error")
            ApiException(
                status,
                err?.optString("code").orEmpty().ifEmpty { "REQUEST_ERROR" },
                err?.optString("message").orEmpty().ifEmpty { "请求失败（$status）" },
            )
        } catch (_: Exception) {
            ApiException(status, "REQUEST_ERROR", "请求失败（$status）")
        }
    }

    private fun readMessage(text: String): String {
        return try {
            JSONObject(text).optJSONObject("error")?.optString("message")
                .orEmpty().ifEmpty { "登录已过期，请重新登录。" }
        } catch (_: Exception) {
            "登录已过期，请重新登录。"
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://jz.yansuu1.xyz"

        /**
         * Strictly bounded and framed SSE stream parser.
         * Enforces line bounds, single event data bounds, total stream bounds,
         * strict UTF-8 decoding without unescaped surrogates / corruption,
         * and avoids emitting incomplete events at EOF.
         */
        internal fun parseSseStream(
            source: okio.BufferedSource,
            maxLineBytes: Long = SseParser.DEFAULT_MAX_LINE_BYTES,
            maxEventDataBytes: Int = SseParser.DEFAULT_MAX_EVENT_DATA_BYTES,
            maxTotalBytes: Long = SseParser.DEFAULT_MAX_TOTAL_BYTES,
            onEvent: (SseEvent) -> Unit,
        ) {
            kotlinx.coroutines.runBlocking {
                SseParser.parse(
                    source = source,
                    maxLineBytes = maxLineBytes,
                    maxEventDataBytes = maxEventDataBytes,
                    maxTotalBytes = maxTotalBytes,
                    onEvent = onEvent,
                )
            }
        }

        /** Validate a candidate baseURL without storing it (login screen test button). */
        fun looksLikeUrl(candidate: String): Boolean {
            val t = candidate.trim()
            val url = runCatching { t.toHttpUrl() }.getOrNull() ?: return false
            return url.username.isEmpty() && url.password.isEmpty() && url.query == null &&
                url.fragment == null && url.encodedPath == "/"
        }
    }
}
