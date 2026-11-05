package com.yansuu1.jizhang.repo

import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.net.AuthenticatedUser
import com.yansuu1.jizhang.net.authenticationErrorMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Auth repository (A2). Mirrors web `stores/auth.ts` + `api.auth`:
 * - `refresh()` → `GET auth/me`; 401 is "not signed in", not an error to surface.
 * - `login(name, password)` → `POST auth/login` (CSRF header included by ApiClient).
 * - `logout()` → `POST auth/logout` (bodiless, no Content-Type per N4);
 *   local state is cleared even if the call fails.
 * - `changePassword()` → `POST auth/password`.
 */
class AuthRepository(private val api: ApiClient) {
    @Volatile var user: AuthenticatedUser? = null
        private set
    val username: String? get() = user?.username
    @Volatile var sessionKey: String = java.util.UUID.randomUUID().toString()
        private set
    var checked: Boolean = false
        private set
    var lastError: String? = null
        private set

    suspend fun refresh() = withContext(Dispatchers.IO) {
        val identity = api.captureRequestIdentity()
        try {
            val me = api.get("/api/v1/auth/me")
            if (api.isCurrent(identity)) {
                user = AuthenticatedUser.fromJson(me)
                sessionKey = java.util.UUID.randomUUID().toString()
                lastError = null
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            if (api.isCurrent(identity)) {
                user = null
            }
        } catch (e: Exception) {
            if (api.isCurrent(identity)) {
                user = null
                lastError = e.message
            }
        } finally {
            if (api.isCurrent(identity)) {
                checked = true
            }
        }
    }

    suspend fun login(name: String, password: String): Boolean = authenticate(
        "/api/v1/auth/login", JSONObject().put("username", name.trim()).put("password", password),
    )

    suspend fun register(draft: RegistrationDraft): Boolean {
        val body = try { draft.toBody() } catch (error: IllegalArgumentException) {
            lastError = error.message
            return false
        }
        return authenticate("/api/v1/auth/register", body)
    }

    private suspend fun authenticate(path: String, body: JSONObject): Boolean = withContext(Dispatchers.IO) {
        val identity = api.advanceSession()
        if (api.isCurrent(identity)) {
            lastError = null
        }
        try {
            val me = api.post(path, body)
            if (api.isCurrent(identity)) {
                user = AuthenticatedUser.fromJson(me, requireStableId = path == "/api/v1/auth/register")
                sessionKey = java.util.UUID.randomUUID().toString()
                api.sessionExpired.value = false
                true
            } else {
                false
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (api.isCurrent(identity)) {
                lastError = authenticationErrorMessage(e)
            }
            false
        }
    }

    suspend fun logout() = withContext(Dispatchers.IO) {
        val identity = api.captureRequestIdentity()
        try {
            api.post("/api/v1/auth/logout")
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Clearing local state is what matters; the server session may be gone.
        } finally {
            if (api.isCurrent(identity)) {
                api.advanceSession()
                api.clearSession()
                user = null
                sessionKey = java.util.UUID.randomUUID().toString()
            }
        }
    }

    suspend fun changePassword(current: String, next: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            val identity = api.captureRequestIdentity()
            try {
                api.post(
                    "/api/v1/auth/password",
                    JSONObject().put("currentPassword", current).put("newPassword", next),
                )
                if (api.isCurrent(identity)) {
                    Result.success(Unit)
                } else {
                    Result.failure(CancellationException("Session expired during password change"))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
}
