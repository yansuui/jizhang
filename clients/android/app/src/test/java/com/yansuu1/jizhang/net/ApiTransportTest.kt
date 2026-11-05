package com.yansuu1.jizhang.net

import com.yansuu1.jizhang.repo.AuthRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class ApiTransportTest {

    @Test
    fun lateResponseCannotExpireOrReplaceNewSession() = runBlocking {
        MockWebServer().use { server ->
            val requestAReceived = CountDownLatch(1)
            val releaseResponseA = CountDownLatch(1)

            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    return when (request.path) {
                        "/api/v1/request-a" -> {
                            requestAReceived.countDown()
                            releaseResponseA.await(5, TimeUnit.SECONDS)
                            MockResponse()
                                .setResponseCode(401)
                                .addHeader("Set-Cookie", "jizhang_session=session_A_late; Path=/")
                                .setBody("""{"error":{"code":"UNAUTHORIZED","message":"A session expired"}}""")
                        }
                        "/api/v1/request-b" -> {
                            MockResponse()
                                .setResponseCode(200)
                                .setBody("""{"ok":true}""")
                        }
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }

            val serverUrl = server.url("/").toString().trimEnd('/')
            val owner = ApiRequestOwner(serverUrl)
            var savedCookies = emptyList<String>()
            val cookieJar = JizhangCookieJar(
                read = { savedCookies },
                write = { savedCookies = it },
            )
            var sessionExpired = false
            val transport = ApiTransport(
                http = OkHttpClient(),
                owner = owner,
                cookieJar = cookieJar,
                onCurrentSessionExpired = { sessionExpired = true },
            )

            // Step A: dispatch request A with identity A
            val identityA = owner.capture()
            val reqA = Request.Builder().url(server.url("/api/v1/request-a")).build()
            var requestAThrewCancellation = false
            val jobA = launch(Dispatchers.IO) {
                try {
                    transport.execute(identityA, reqA) { resp ->
                        resp.body?.string()
                    }
                } catch (_: CancellationException) {
                    requestAThrewCancellation = true
                }
            }

            assertTrue("Request A must reach server", requestAReceived.await(5, TimeUnit.SECONDS))

            // Step B: advance generation to B, save B's session cookie
            val identityB = owner.advance(serverUrl)
            cookieJar.saveFromResponse(
                server.url("/"),
                listOf(Cookie.parse(server.url("/"), "jizhang_session=session_B_active; Path=/")!!),
            )

            // Step C: release late response A
            releaseResponseA.countDown()
            jobA.join()

            assertTrue("Late A response must end with CancellationException", requestAThrewCancellation)
            assertFalse("sessionExpired must remain false for late A response", sessionExpired)

            val cookies = cookieJar.loadForRequest(server.url("/api/v1/request-b"))
            assertEquals("B session cookie must not be overwritten by A", 1, cookies.size)
            assertEquals("session_B_active", cookies.first().value)

            // Step D: request B succeeds with B's cookie
            val reqB = Request.Builder().url(server.url("/api/v1/request-b")).build()
            val resultB = transport.execute(identityB, reqB) { resp ->
                assertEquals(200, resp.code)
                resp.body?.string()
            }
            assertNotNull(resultB)
            assertTrue(resultB!!.contains(""""ok":true"""))

            // Verify recorded requests
            val reqARecorded = server.takeRequest()
            assertEquals("/api/v1/request-a", reqARecorded.path)

            val reqBRecorded = server.takeRequest()
            assertEquals("/api/v1/request-b", reqBRecorded.path)
            assertEquals("jizhang_session=session_B_active", reqBRecorded.getHeader("Cookie"))
        }
    }

    @Test
    fun aToBToACannotRevertToOldGeneration() {
        val owner = ApiRequestOwner("https://serverA.com")
        val identityA1 = owner.capture()
        assertEquals("https://serverA.com", identityA1.baseUrl)
        assertEquals(1L, identityA1.generation)
        assertTrue(owner.isCurrent(identityA1))

        // Switch to server B
        val identityB = owner.advance("https://serverB.com")
        assertEquals("https://serverB.com", identityB.baseUrl)
        assertEquals(2L, identityB.generation)
        assertFalse(owner.isCurrent(identityA1))
        assertTrue(owner.isCurrent(identityB))

        // Switch back to server A
        val identityA2 = owner.advance("https://serverA.com")
        assertEquals("https://serverA.com", identityA2.baseUrl)
        assertEquals(3L, identityA2.generation)
        // Generation 1 for server A must NOT be current
        assertFalse("Old generation for serverA must not revert to current", owner.isCurrent(identityA1))
        assertFalse(owner.isCurrent(identityB))
        assertTrue(owner.isCurrent(identityA2))
    }

    @Test
    fun currentSession401ExpiresSession() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse()
                    .setResponseCode(401)
                    .setBody("""{"error":{"code":"UNAUTHORIZED","message":"Token expired"}}"""),
            )

            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val cookieJar = JizhangCookieJar()
            cookieJar.saveFromResponse(
                server.url("/"),
                listOf(Cookie.parse(server.url("/"), "jizhang_session=valid; Path=/")!!),
            )
            var sessionExpired = false
            val transport = ApiTransport(
                http = OkHttpClient(),
                owner = owner,
                cookieJar = cookieJar,
                onCurrentSessionExpired = { sessionExpired = true },
            )

            val identity = owner.capture()
            val req = Request.Builder().url(server.url("/api/v1/auth/me")).build()

            var thrown: AuthExpiredException? = null
            try {
                transport.execute(identity, req) { resp ->
                    if (resp.code == 401) throw AuthExpiredException()
                    resp.body?.string()
                }
            } catch (e: AuthExpiredException) {
                thrown = e
            }

            assertNotNull(thrown)
            assertTrue("sessionExpired must be set to true on current 401", sessionExpired)
            assertTrue("CookieJar must be cleared on current 401", cookieJar.loadForRequest(server.url("/")).isEmpty())
        }
    }

    @Test
    fun login401DoesNotExpireSession() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse()
                    .setResponseCode(401)
                    .setBody("""{"error":{"code":"INVALID_CREDENTIALS","message":"Invalid username or password"}}"""),
            )

            val owner = ApiRequestOwner(server.url("/").toString().trimEnd('/'))
            val cookieJar = JizhangCookieJar()
            cookieJar.saveFromResponse(
                server.url("/"),
                listOf(Cookie.parse(server.url("/"), "jizhang_session=valid_session; Path=/")!!),
            )
            var sessionExpired = false
            val transport = ApiTransport(
                http = OkHttpClient(),
                owner = owner,
                cookieJar = cookieJar,
                onCurrentSessionExpired = { sessionExpired = true },
            )

            val identity = owner.capture()
            val req = apiRequest("POST", server.url("/api/v1/auth/login"))

            var status = 0
            transport.execute(identity, req) { resp ->
                status = resp.code
                resp.body?.string()
            }

            assertEquals(401, status)
            assertFalse("Login 401 must not trigger sessionExpired", sessionExpired)
            assertFalse("CookieJar must not be cleared on login 401", cookieJar.loadForRequest(server.url("/")).isEmpty())
        }
    }

    @Test
    fun cancelledJsonAndDownloadCloseTransport() = runBlocking {
        // 1. Test JSON call cancellation when server blocks reading body
        val serverSocket = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val acceptedSocket = AtomicReference<Socket?>()
        val requestReceived = CountDownLatch(1)
        val releaseServer = CountDownLatch(1)

        val serverThread = Thread {
            try {
                serverSocket.accept().use { socket ->
                    acceptedSocket.set(socket)
                    requestReceived.countDown()
                    val eol = "\r\n"
                    val response = "HTTP/1.1 200 OK${eol}Content-Type: application/json${eol}Content-Length: 100000${eol}${eol}part"
                    socket.getOutputStream().write(response.toByteArray())
                    socket.getOutputStream().flush()
                    releaseServer.await(5, TimeUnit.SECONDS)
                }
            } catch (_: Exception) {
            } finally {
                serverSocket.close()
            }
        }.apply { isDaemon = true; start() }

        val serverUrl = "http://127.0.0.1:${serverSocket.localPort}"
        val owner = ApiRequestOwner(serverUrl)
        val cookieJar = JizhangCookieJar()
        val transport = ApiTransport(
            http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build(),
            owner = owner,
            cookieJar = cookieJar,
            onCurrentSessionExpired = {},
        )

        val identity = owner.capture()
        val req = Request.Builder().url("$serverUrl/api/v1/large-json").build()

        var callInstance: Call? = null
        var successCalled = false

        val job = launch(Dispatchers.IO) {
            try {
                transport.execute(identity, req, onCallCreated = { callInstance = it }) { resp ->
                    resp.body!!.bytes()
                    successCalled = true
                }
            } catch (_: CancellationException) {
            }
        }

        try {
            assertTrue(requestReceived.await(5, TimeUnit.SECONDS))
            job.cancel()
            withTimeout(2000) { job.join() }

            assertFalse("Success callback must not be invoked on cancelled read", successCalled)
            assertNotNull(callInstance)
            assertTrue("OkHttp Call must be canceled promptly", callInstance!!.isCanceled())
        } finally {
            releaseServer.countDown()
            acceptedSocket.get()?.close()
            serverSocket.close()
            job.cancel()
            serverThread.join(2000)
        }

        // 2. Test download cancellation
        val downloadServerSocket = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val downloadAcceptedSocket = AtomicReference<Socket?>()
        val downloadReceived = CountDownLatch(1)
        val releaseDownload = CountDownLatch(1)

        val downloadServerThread = Thread {
            try {
                downloadServerSocket.accept().use { socket ->
                    downloadAcceptedSocket.set(socket)
                    downloadReceived.countDown()
                    val eol = "\r\n"
                    val response = "HTTP/1.1 200 OK${eol}Content-Type: application/octet-stream${eol}Content-Length: 100000${eol}${eol}part"
                    socket.getOutputStream().write(response.toByteArray())
                    socket.getOutputStream().flush()
                    releaseDownload.await(5, TimeUnit.SECONDS)
                }
            } catch (_: Exception) {
            } finally {
                downloadServerSocket.close()
            }
        }.apply { isDaemon = true; start() }

        val downloadUrl = "http://127.0.0.1:${downloadServerSocket.localPort}"
        val downloadOwner = ApiRequestOwner(downloadUrl)
        val downloadTransport = ApiTransport(
            http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build(),
            owner = downloadOwner,
            cookieJar = JizhangCookieJar(),
            onCurrentSessionExpired = {},
        )

        var downloadCallInstance: Call? = null
        var downloadSuccess = false

        val downloadJob = launch(Dispatchers.IO) {
            try {
                downloadTransport.execute(
                    downloadOwner.capture(),
                    Request.Builder().url("$downloadUrl/download").build(),
                    onCallCreated = { downloadCallInstance = it },
                ) { resp ->
                    resp.body!!.bytes()
                    downloadSuccess = true
                }
            } catch (_: CancellationException) {
            }
        }

        try {
            assertTrue(downloadReceived.await(5, TimeUnit.SECONDS))
            downloadJob.cancel()
            withTimeout(2000) { downloadJob.join() }

            assertFalse("Success callback must not be called on cancelled download", downloadSuccess)
            assertNotNull(downloadCallInstance)
            assertTrue("Download OkHttp Call must be canceled promptly", downloadCallInstance!!.isCanceled())
        } finally {
            releaseDownload.countDown()
            downloadAcceptedSocket.get()?.close()
            downloadServerSocket.close()
            downloadJob.cancel()
            downloadServerThread.join(2000)
        }
    }

    @Test
    fun expiredLogoutDoesNotClearNewSessionUnderOwner() {
        val owner = ApiRequestOwner("https://server.com")
        var savedCookies = emptyList<String>()
        val cookieJar = JizhangCookieJar(read = { savedCookies }, write = { savedCookies = it })

        // Session A starts
        val identityA = owner.capture()
        cookieJar.saveFromResponse(
            "https://server.com/".toHttpUrl(),
            listOf(Cookie.parse("https://server.com/".toHttpUrl(), "jizhang_session=user_A; Path=/")!!),
        )

        // Logout A begins with identity A...
        // While logout A is in-flight, new login for B starts:
        val identityB = owner.advance("https://server.com")
        assertTrue(owner.isCurrent(identityB))
        cookieJar.saveFromResponse(
            "https://server.com/".toHttpUrl(),
            listOf(Cookie.parse("https://server.com/".toHttpUrl(), "jizhang_session=user_B; Path=/")!!),
        )

        // Logout A reaches finally block:
        val cleared = owner.ifCurrent(identityA) {
            cookieJar.clear()
        }

        assertFalse("Logout A must not clear session because generation advanced", cleared)
        val currentCookies = cookieJar.loadForRequest("https://server.com/".toHttpUrl())
        assertEquals("Session B cookie must remain intact", 1, currentCookies.size)
        assertEquals("user_B", currentCookies.first().value)
    }
}
