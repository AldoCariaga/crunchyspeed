package dev.crunchyspeed

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * A single-site browser for crunchyroll.com that injects a playback-speed menu
 * (see assets/speed.js) into every Crunchyroll frame, including the player iframe.
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    /** Black screen with an orange spinner that hides the page until it is mostly loaded. */
    private lateinit var loadingOverlay: FrameLayout
    private val hideLoadingFallback = Runnable { hideLoading() }
    /** speed.js posts "ready" when the content has rendered; without message support, go by load progress. */
    private val pageReportsReady get() = playStateReported

    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    /** Frames (by their reply proxy, one per frame) that last reported a playing video. */
    private val playingFrames = mutableSetOf<JavaScriptReplyProxy>()
    /** False on old WebViews without message listeners: then fall back to "on while fullscreen". */
    private var playStateReported = false

    private var speedScript: ScriptHandler? = null
    private var speed = DEFAULT_SPEED

    private val prefs by lazy { getSharedPreferences("settings", MODE_PRIVATE) }
    private val speedJs by lazy { assets.open("speed.js").bufferedReader().use { it.readText() } }
    private val insetsController by lazy { WindowCompat.getInsetsController(window, window.decorView) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        speed = prefs.getFloat(KEY_SPEED, DEFAULT_SPEED)

        // Draw edge to edge; we pad for the system bars ourselves (and drop the padding in fullscreen).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        insetsController.isAppearanceLightStatusBars = false
        insetsController.isAppearanceLightNavigationBars = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        webView = WebView(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(webView, matchParent())
        loadingOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            isClickable = true // swallow taps meant for the half-loaded page underneath
            addView(
                ProgressBar(this@MainActivity).apply {
                    isIndeterminate = true
                    indeterminateTintList = ColorStateList.valueOf(ORANGE)
                },
                FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER)
            )
        }
        root.addView(loadingOverlay, matchParent()) // above the WebView, below any fullscreen video
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            if (fullscreenView != null) {
                v.setPadding(0, 0, 0, 0)
            } else {
                val bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
                )
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            }
            WindowInsetsCompat.CONSUMED
        }

        setUpWebView()
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(HOME)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true) // the player iframe needs the session cookies
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        presentAsDesktopChrome()

        installSpeedScript()

        // The page reports speed changes here so the choice survives restarts, and reports
        // "playing"/"idle" per frame so the screen stays on only while a video plays.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            playStateReported = true
            WebViewCompat.addWebMessageListener(webView, "CRSpeed", ORIGIN_RULES) { _, message, _, isMainFrame, frame ->
                when (val data = message.data) {
                    "playing" -> { playingFrames.add(frame); updateKeepScreenOn() }
                    "idle" -> { playingFrames.remove(frame); updateKeepScreenOn() }
                    "loading" -> if (isMainFrame) showLoading()
                    "ready" -> if (isMainFrame) hideLoading()
                    else -> data?.toFloatOrNull()?.takeIf { it in 0.25f..4f }?.let(::saveSpeed)
                }
            }
        }

        webView.webViewClient = Client()
        webView.webChromeClient = ChromeClient()
    }

    /**
     * Crunchyroll's site refuses to play on phones ("Watch this on the Crunchyroll App"), so
     * identify as desktop Chrome on Windows: UA string, UA client hints, and navigator.platform
     * (the last one is set in [speedScriptSource]). The viewport stays phone-sized, so the
     * layout is still the mobile one.
     */
    private fun presentAsDesktopChrome() {
        val settings = webView.settings
        val fullVersion = Regex("""Chrome/([\d.]+)""").find(settings.userAgentString)?.groupValues?.get(1)
            ?: "130.0.0.0"
        val major = fullVersion.substringBefore('.')
        settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"

        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            fun brand(name: String, ver: String) = UserAgentMetadata.BrandVersion.Builder()
                .setBrand(name).setMajorVersion(ver.substringBefore('.')).setFullVersion(ver).build()
            WebSettingsCompat.setUserAgentMetadata(
                settings,
                UserAgentMetadata.Builder()
                    .setBrandVersionList(
                        listOf(brand("Chromium", fullVersion), brand("Google Chrome", fullVersion), brand("Not:A-Brand", "8.0.0.0"))
                    )
                    .setFullVersion(fullVersion)
                    .setPlatform("Windows")
                    .setPlatformVersion("10.0.0")
                    .setArchitecture("x86")
                    .setBitness(64)
                    .setModel("")
                    .setMobile(false)
                    .setWow64(false)
                    .build()
            )
        }
    }

    private fun speedScriptSource() =
        "try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: true }); } catch (e) {}\n" +
            "window.__CR_SAVED_SPEED = $speed;\n$speedJs"

    /** Injects speed.js at document start into every Crunchyroll frame (main page and player iframe). */
    private fun installSpeedScript() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        speedScript?.remove()
        speedScript = WebViewCompat.addDocumentStartJavaScript(webView, speedScriptSource(), ORIGIN_RULES)
    }

    private fun saveSpeed(value: Float) {
        if (value == speed) return
        speed = value
        prefs.edit().putFloat(KEY_SPEED, value).apply()
        installSpeedScript() // pages loaded from now on start at the new speed
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val url = request.url
            return when {
                isCrunchyroll(url) || url.scheme == "about" -> false
                url.scheme == "http" || url.scheme == "https" -> {
                    // Only links the user actually tapped go to the browser; silent redirects are dropped.
                    if (request.hasGesture()) openExternally(url)
                    true
                }
                else -> true // intent://, market://, app deep links ("open in app" banners): ignore
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            playingFrames.clear() // the old page's frames are gone; the new page reports afresh
            updateKeepScreenOn()
            showLoading()
        }

        override fun onPageFinished(view: WebView, url: String) {
            // On Crunchyroll pages speed.js says when the content has rendered ("ready");
            // anything else (an error page, or no message support) is as good as it gets now.
            if (!pageReportsReady || !isCrunchyroll(Uri.parse(url))) hideLoading()
            // Fallback for very old WebView versions without document-start scripts (main frame only).
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                view.evaluateJavascript(speedScriptSource(), null)
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            recreate() // the WebView is unusable now; start over instead of crashing
            return true
        }
    }

    private inner class ChromeClient : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (!pageReportsReady && newProgress >= REVEAL_PROGRESS) hideLoading()
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // Allow Widevine (protected media) for Crunchyroll only; deny everything else.
            val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
            if (isCrunchyroll(request.origin) && wanted.isNotEmpty()) {
                request.grant(wanted.toTypedArray())
            } else {
                request.deny()
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) = enterFullscreen(view, callback)

        override fun onHideCustomView() = exitFullscreen()
    }

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        root.addView(view, matchParent())
        insetsController.hide(WindowInsetsCompat.Type.systemBars())
        insetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        updateKeepScreenOn()
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        ViewCompat.requestApplyInsets(root)
    }

    private fun exitFullscreen() {
        val view = fullscreenView ?: return
        val callback = fullscreenCallback
        fullscreenView = null
        fullscreenCallback = null
        root.removeView(view)
        insetsController.show(WindowInsetsCompat.Type.systemBars())
        updateKeepScreenOn()
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        ViewCompat.requestApplyInsets(root)
        callback?.onCustomViewHidden()
    }

    private fun showLoading(timeoutMs: Long = LOADING_TIMEOUT_MS) {
        loadingOverlay.animate().cancel()
        loadingOverlay.alpha = 1f
        loadingOverlay.visibility = View.VISIBLE
        // Never trap the user behind the spinner if a slow resource stalls the progress bar.
        root.removeCallbacks(hideLoadingFallback)
        root.postDelayed(hideLoadingFallback, timeoutMs)
    }

    private fun hideLoading() {
        root.removeCallbacks(hideLoadingFallback)
        if (loadingOverlay.visibility != View.VISIBLE || loadingOverlay.alpha < 1f) return // gone or fading
        loadingOverlay.animate().alpha(0f).setDuration(200).withEndAction {
            loadingOverlay.visibility = View.GONE
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    /** Keep the screen awake while a video plays (in or out of fullscreen); otherwise let it sleep. */
    private fun updateKeepScreenOn() {
        val keepOn = if (playStateReported) playingFrames.isNotEmpty() else fullscreenView != null
        if (keepOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            fullscreenView != null -> exitFullscreen()
            webView.canGoBack() -> {
                // Cover the old page right away; it can linger ~1 s before the previous one shows.
                // The page (popstate) or the new load (onPageStarted) then takes over the spinner;
                // the short timeout covers a back step that changes nothing visible.
                if (pageReportsReady) showLoading(BACK_TIMEOUT_MS)
                // Stop the video now; the site can take a second to tear the player down.
                playingFrames.toList().forEach { frame -> runCatching { frame.postMessage("pause") } }
                webView.goBack()
            }
            else -> super.onBackPressed()
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush() // keep the login across restarts
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        root.removeCallbacks(hideLoadingFallback)
        root.removeAllViews()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOME = "https://www.crunchyroll.com/"
        private const val KEY_SPEED = "speed"
        private const val DEFAULT_SPEED = 1.5f
        private const val ORANGE = 0xFFF47521.toInt()
        /** Fallback for WebViews without message support: load progress (0–100) that reveals the page. */
        private const val REVEAL_PROGRESS = 80
        private const val LOADING_TIMEOUT_MS = 15_000L
        private const val BACK_TIMEOUT_MS = 3_000L
        private val ORIGIN_RULES = setOf("https://crunchyroll.com", "https://*.crunchyroll.com")

        private fun matchParent() =
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

        fun isCrunchyroll(uri: Uri?): Boolean {
            if (uri == null || (uri.scheme != "https" && uri.scheme != "http")) return false
            val host = uri.host?.lowercase() ?: return false
            return host == "crunchyroll.com" || host.endsWith(".crunchyroll.com")
        }
    }
}
