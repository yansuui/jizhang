package com.yansuu1.jizhang

import android.animation.ValueAnimator
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import com.yansuu1.jizhang.net.ApiClient
import com.yansuu1.jizhang.repo.AuthRepository
import com.yansuu1.jizhang.ui.LoginScreen
import com.yansuu1.jizhang.ui.MainShell
import com.yansuu1.jizhang.ui.readThemePrefs
import com.yansuu1.jizhang.ui.theme.AccentPreset
import com.yansuu1.jizhang.ui.theme.JizhangTheme
import com.yansuu1.jizhang.ui.theme.ThemePreference
import com.yansuu1.jizhang.ui.writeThemePrefs
import kotlinx.coroutines.launch
import androidx.compose.runtime.collectAsState
import com.yansuu1.jizhang.ui.readReduceMotionPref
import com.yansuu1.jizhang.ui.writeReduceMotionPref

/**
 * Entry: session gate (login <-> shell) + persisted theme (A10/A11).
 * Mirrors web `router/index.ts` guard: the session resolves once before
 * deciding where to land; 401 stays on login.
 */
class MainActivity : ComponentActivity() {
    private var systemAnimationsEnabled by mutableStateOf(true)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        systemAnimationsEnabled = ValueAnimator.areAnimatorsEnabled()
        val api = ApiClient(applicationContext)
        val auth = AuthRepository(api)
        setContent {
            val scope = rememberCoroutineScope()
            var theme by remember { mutableStateOf(ThemePreference.System) }
            var accent by remember { mutableStateOf(AccentPreset.Titanium) }
            var reduceMotion by remember { mutableStateOf(false) }
            LaunchedEffect(Unit) {
                val (t, a) = readThemePrefs(applicationContext)
                theme = t
                accent = a
                reduceMotion = readReduceMotionPref(applicationContext)
            }
            JizhangTheme(
                preference = theme,
                accent = accent,
                reduceMotion = reduceMotion || !systemAnimationsEnabled,
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    var signedIn by remember { mutableStateOf(false) }
                    val expired by api.sessionExpired.collectAsState()
                    LaunchedEffect(expired) { if (expired) signedIn = false }
                    if (signedIn) {
                        key(auth.sessionKey) {
                        MainShell(
                            api = api,
                            auth = auth,
                            theme = theme,
                            accent = accent,
                            onTheme = { t ->
                                theme = t
                                scope.launch { writeThemePrefs(applicationContext, t, accent) }
                            },
                            onAccent = { a ->
                                accent = a
                                scope.launch { writeThemePrefs(applicationContext, theme, a) }
                            },
                            reduceMotion = reduceMotion,
                            onReduceMotion = { reduced ->
                                reduceMotion = reduced
                                scope.launch {
                                    try {
                                        writeReduceMotionPref(applicationContext, reduced)
                                    } catch (_: Exception) {
                                        Toast.makeText(
                                            applicationContext,
                                            "减少动态设置未能保存，当前仅本次打开有效。",
                                            Toast.LENGTH_LONG,
                                        ).show()
                                    }
                                }
                            },
                            onLogout = { signedIn = false },
                            onAuthExpired = { signedIn = false },
                        )
                        }
                    } else {
                        LoginScreen(
                            api = api,
                            auth = auth,
                            onLoggedIn = { signedIn = true },
                        )
                    }
                }
            }
            @Suppress("UNUSED_EXPRESSION")
            isSystemInDarkTheme().let { }
        }
    }

    override fun onResume() {
        super.onResume()
        systemAnimationsEnabled = ValueAnimator.areAnimatorsEnabled()
    }
}
