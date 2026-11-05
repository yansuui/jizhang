package com.yansuu1.jizhang.net

import com.yansuu1.jizhang.repo.RegistrationDraft
import com.yansuu1.jizhang.repo.Invitation
import com.yansuu1.jizhang.ui.FinancialScope
import com.yansuu1.jizhang.ui.OperationReplayStore
import com.yansuu1.jizhang.ui.sameIdentity
import kotlinx.coroutines.runBlocking
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MultiuserAuthenticationTest {
    private val adminJson = """{"id":"owner-id","username":"owner","role":"admin","capabilities":["manageInvitations"],"expiresAt":4102444800000}"""

    @Test fun absentOrUntrustedCapabilitiesNeverGrantAdministration() {
        assertFalse(AuthenticatedUser.fromJson(JSONObject("""{"username":"owner","expiresAt":4102444800000}""")).canManageInvitations)
        assertTrue(AuthenticatedUser.fromJson(JSONObject(adminJson)).canManageInvitations)
        assertFalse(AuthenticatedUser.fromJson(JSONObject(adminJson).put("role", "member")).canManageInvitations)
        assertFalse(AuthenticatedUser.fromJson(JSONObject(adminJson).removeAndReturn("capabilities")).canManageInvitations)
        assertThrows(IllegalArgumentException::class.java) {
            AuthenticatedUser.fromJson(JSONObject(adminJson).put("id", ""))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AuthenticatedUser.fromJson(JSONObject(adminJson).removeAndReturn("id"), requireStableId = true)
        }
    }

    @Test fun registrationPreservesPasswordAndRequiresMatchingBoundedFields() {
        val draft = RegistrationDraft(" new.user ", " password8 ", " password8 ", " invite ")
        val body = draft.toBody()
        assertEquals("new.user", body.getString("username"))
        assertEquals(" password8 ", body.getString("password"))
        assertEquals("invite", body.getString("invitationCode"))
        assertFalse(body.has("confirmation"))
        assertThrows(IllegalArgumentException::class.java) { draft.copy(confirmation = "password8").toBody() }
        assertThrows(IllegalArgumentException::class.java) { draft.copy(username = "ab").toBody() }
        assertThrows(IllegalArgumentException::class.java) { draft.copy(username = "中文账号").toBody() }
        assertThrows(IllegalArgumentException::class.java) { draft.copy(password = "🪴".repeat(65), confirmation = "🪴".repeat(65)).toBody() }
    }

    @Test fun stableIdsNeverAdoptUsernameOnlyPendingWrites() {
        val old = FinancialScope("https://example.com", "same-name")
        val first = old.copy(userId = "first-id")
        val recreated = old.copy(userId = "second-id")
        assertNotEquals(OperationReplayStore.prefixFor(old.serverBaseUrl, old.storageIdentity),
            OperationReplayStore.prefixFor(first.serverBaseUrl, first.storageIdentity))
        assertNotEquals(OperationReplayStore.prefixFor(first.serverBaseUrl, first.storageIdentity),
            OperationReplayStore.prefixFor(recreated.serverBaseUrl, recreated.storageIdentity))
        assertFalse(first.sameIdentity(recreated))
        assertTrue(first.sameIdentity(first.copy(username = "renamed")))
        assertTrue(OperationReplayStore.prefixFor(first.serverBaseUrl, first.storageIdentity).startsWith("op_v2_"))
    }

    @Test fun registrationFailureCannotReplaceOrExpireSavedAccount() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401)
                .addHeader("Set-Cookie", "jizhang_session=unaccepted; Path=/")
                .setBody("""{"error":{"code":"INVALID_INVITATION"}}"""))
            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val jar = JizhangCookieJar()
            jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "jizhang_session=saved; Path=/")!!))
            var expired = false
            val transport = ApiTransport(OkHttpClient(), owner, jar) { expired = true }
            transport.execute(owner.capture(), apiRequest("POST", server.url("/api/v1/auth/register"))) { it.code }
            assertNull(server.takeRequest().getHeader("Cookie"))
            assertEquals("saved", jar.loadForRequest(server.url("/")).single().value)
            assertFalse(expired)
        }
    }

    @Test fun malformedRegistrationResponseNeverPersistsNewCookie() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(201).addHeader("Set-Cookie", "jizhang_session=new; Path=/")
                .setBody("""{"username":"new","expiresAt":4102444800000}"""))
            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val jar = JizhangCookieJar()
            val transport = ApiTransport(OkHttpClient(), owner, jar) {}
            try {
                transport.execute(owner.capture(), apiRequest("POST", server.url("/api/v1/auth/register"))) {
                    AuthenticatedUser.fromJson(JSONObject(it.body!!.string()), requireStableId = true)
                }
                fail("Missing immutable ID must reject registration")
            } catch (_: IllegalArgumentException) {}
            assertTrue(jar.loadForRequest(server.url("/")).isEmpty())
        }
    }

    @Test fun validRegistrationWithoutSessionCookieCannotActivateOldSavedCookie() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(201).setBody(adminJson))
            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val jar = JizhangCookieJar()
            jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "jizhang_session=old; Path=/")!!))
            val transport = ApiTransport(OkHttpClient(), owner, jar) {}
            try {
                transport.execute(owner.capture(), apiRequest("POST", server.url("/api/v1/auth/register"))) {
                    AuthenticatedUser.fromJson(JSONObject(it.body!!.string()), requireStableId = true)
                }
                fail("Missing cookie must fail")
            } catch (failure: ApiException) { assertEquals("SESSION_MISSING", failure.code) }
            assertEquals("old", jar.loadForRequest(server.url("/")).single().value)
        }
    }

    @Test fun successfulRegistrationReplacesSavedCookieAfterValidation() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(201).setBody(adminJson)
                .addHeader("Set-Cookie", "jizhang_session=accepted; Path=/; HttpOnly"))
            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val jar = JizhangCookieJar()
            val transport = ApiTransport(OkHttpClient(), owner, jar) {}
            val user = transport.execute(owner.capture(), apiRequest("POST", server.url("/api/v1/auth/register"))) {
                AuthenticatedUser.fromJson(JSONObject(it.body!!.string()), requireStableId = true)
            }
            assertEquals("owner-id", user.id)
            assertEquals("accepted", jar.loadForRequest(server.url("/")).single().value)
            assertNull(server.takeRequest().getHeader("Cookie"))
        }
    }

    @Test fun publicAuthenticationDoesNotFollowRedirects() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", server.url("/redirected")))
            server.enqueue(MockResponse().setResponseCode(200))
            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val transport = ApiTransport(OkHttpClient(), owner, JizhangCookieJar()) {}
            val code = transport.execute(owner.capture(), apiRequest("POST", server.url("/api/v1/auth/register"))) { it.code }
            assertEquals(307, code)
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun invitationWireContractUsesServerExpiryAndSafePath() {
        val invitation = Invitation.fromJson(JSONObject("""{"id":"one","createdAt":1000,"expiresAt":2000,"status":"active","usedAt":null}"""))
        assertEquals("active", invitation.currentStatus(1999))
        assertEquals("expired", invitation.currentStatus(2000))
        assertNull(invitation.usedAt)
        assertFalse(invitation.copy(id = "other?x=1").revokePath().contains("?"))
        assertThrows(IllegalArgumentException::class.java) { invitation.copy(id = "..").revokePath() }
    }

    private fun JSONObject.removeAndReturn(key: String): JSONObject = apply { remove(key) }
}
