package com.yansuu1.jizhang.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/**
 * Android Context-free transport layer enforcing request session identity,
 * prompt OkHttp Call cancellation, and cookie/session lifecycle isolation.
 */
internal class ApiTransport(
    private val http: OkHttpClient,
    private val owner: ApiRequestOwner,
    private val cookieJar: JizhangCookieJar,
    private val onCurrentSessionExpired: () -> Unit,
) {
    suspend fun <T> execute(
        identity: ApiRequestIdentity,
        request: Request,
        read: suspend (Response) -> T,
    ): T = executeInternal(identity, request, clientOverride = null, onCallCreated = null, read = read)

    suspend fun <T> execute(
        identity: ApiRequestIdentity,
        request: Request,
        clientOverride: OkHttpClient? = null,
        onCallCreated: ((Call) -> Unit)? = null,
        read: suspend (Response) -> T,
    ): T = executeInternal(identity, request, clientOverride, onCallCreated, read)

    private suspend fun <T> executeInternal(
        identity: ApiRequestIdentity,
        request: Request,
        clientOverride: OkHttpClient?,
        onCallCreated: ((Call) -> Unit)?,
        read: suspend (Response) -> T,
    ): T = coroutineScope {
        // 1. Pre-dispatch check
        if (!owner.isCurrent(identity)) {
            throw CancellationException("Request identity expired before dispatch ($identity)")
        }

        // 2. Attach cookies if current identity
        val reqBuilder = request.newBuilder()
            .tag(ApiRequestIdentity::class.java, identity)
        val publicAuthentication = request.method == "POST" && isPublicAuthenticationPath(request.url.encodedPath)

        if (publicAuthentication) {
            reqBuilder.removeHeader("Cookie")
        } else if (request.header("Cookie") == null) {
            val cookies = if (owner.isCurrent(identity)) {
                cookieJar.loadForRequest(request.url)
            } else {
                emptyList()
            }
            if (cookies.isNotEmpty()) {
                reqBuilder.header("Cookie", cookies.joinToString("; ") { "${it.name}=${it.value}" })
            }
        }
        val req = reqBuilder.build()

        // 3. Prepare client with NO_COOKIES so BridgeInterceptor cannot bypass identity checks
        val base = clientOverride ?: http
        val client = base.newBuilder()
            .cookieJar(CookieJar.NO_COOKIES)
            .apply {
                if (publicAuthentication) { followRedirects(false); followSslRedirects(false) }
            }
            .build()

        val call = client.newCall(req)
        onCallCreated?.invoke(call)

        val cancellationHandle = currentCoroutineContext()[Job]?.invokeOnCompletion {
            call.cancel()
        }

        val readerJob = async(Dispatchers.IO) {
            try {
                val response = call.execute()
                response.use { resp ->
                    // 4. Response arrival identity check
                    if (!owner.isCurrent(identity)) {
                        throw CancellationException("Response arrived for expired request identity ($identity)")
                    }

                    // Public authentication errors belong to this attempt, not a saved account.
                    if (resp.code == 401 && !publicAuthentication) {
                        owner.ifCurrent(identity) {
                            cookieJar.clear()
                            onCurrentSessionExpired()
                        }
                    }

                    val result = read(resp)

                    // 7. Post-read check
                    if (!owner.isCurrent(identity)) {
                        throw CancellationException("Request identity expired after reading response ($identity)")
                    }
                    // A malformed/rejected auth envelope must never replace a saved credential.
                    if (resp.isSuccessful) {
                        val parsed = resp.headers("Set-Cookie").mapNotNull { Cookie.parse(req.url, it) }
                        val sessionUrl = req.url.newBuilder().encodedPath("/api/v1/auth/me").query(null).build()
                        if (publicAuthentication && parsed.none {
                            it.name == "jizhang_session" && it.value.isNotEmpty() &&
                                it.expiresAt > System.currentTimeMillis() && it.matches(sessionUrl)
                        }) {
                            throw ApiException(401, "SESSION_MISSING", "未收到有效登录会话，请检查服务连接。")
                        }
                        owner.ifCurrent(identity) {
                            if (publicAuthentication) cookieJar.clear()
                            if (parsed.isNotEmpty()) cookieJar.saveFromResponse(req.url, parsed)
                        }
                    }
                    result
                }
            } catch (e: IOException) {
                if (call.isCanceled() || !currentCoroutineContext().isActive) {
                    throw CancellationException("Call cancelled", e)
                }
                throw e
            }
        }

        try {
            readerJob.await()
        } finally {
            cancellationHandle?.dispose()
            if (!readerJob.isCompleted) {
                call.cancel()
                readerJob.cancel()
            }
        }
    }
}
