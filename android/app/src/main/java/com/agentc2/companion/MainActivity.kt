package com.agentc2.companion

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** A scoped browser for the desktop-hosted companion. No JavaScript/native bridge. */
@Suppress("DEPRECATION")
class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private var web: WebView? = null
    private var connection: ConnectionPolicy? = null
    private var picker: ValueCallback<Array<Uri>>? = null
    private lateinit var status: TextView
    private val popups = mutableSetOf<WebView>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; id = 3; fitsSystemWindows = true }
        setContentView(root)
        showConnection()
    }

    private fun button(text: String, identifier: Int, action: () -> Unit): Button {
        return Button(this).apply { this.text = text; id = identifier; setOnClickListener { action() } }
    }

    private fun closePopups() {
        popups.forEach { it.destroy() }
        popups.clear()
    }

    private fun showConnection() {
        picker?.onReceiveValue(null)
        picker = null
        closePopups()
        web?.destroy()
        web = null
        connection = null
        root.removeAllViews()
        val spacing = (24 * resources.displayMetrics.density).toInt()
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(spacing, spacing, spacing, spacing)
        }
        root.addView(form)
        form.addView(TextView(this).apply { text = "AgentC2 Companion\nConnect to your desktop on Tailscale. Paste its address or pairing link."; textSize = 20f })
        val input = AutoCompleteTextView(this).apply {
            id = 1
            hint = "https://desktop.tailnet.ts.net"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setAdapter(ArrayAdapter(this@MainActivity, android.R.layout.simple_dropdown_item_1line,
                getPreferences(MODE_PRIVATE).getStringSet("origins", emptySet())!!.sorted()))
            threshold = 1
            setText(getPreferences(MODE_PRIVATE).getString("origin", ""))
        }
        form.addView(input)
        form.addView(button("Connect", 2) {
            val target = ConnectionPolicy.parse(input.text.toString())
            if (target == null) input.error = "Use a Tailscale HTTPS address or http://100.64–127.x.x address and optional pairing link."
            else connect(target)
        })
        form.addView(button("Forget device", 5) {
            getPreferences(MODE_PRIVATE).edit().clear().apply()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            input.setText("")
        })
    }

    private fun connect(target: ConnectionPolicy) {
        val preferences = getPreferences(MODE_PRIVATE)
        preferences.edit().putString("origin", target.origin)
            .putStringSet("origins", preferences.getStringSet("origins", emptySet())!! + target.origin).apply()
        connection = target
        root.removeAllViews()
        val controls = LinearLayout(this)
        controls.addView(button("Change desktop", 4) { showConnection() })
        controls.addView(button("Reconnect", 6) { status.visibility = View.GONE; web!!.loadUrl(target.origin + "/companion.html") })
        root.addView(controls)
        status = TextView(this).apply { setTextColor(Color.RED); visibility = View.GONE }
        root.addView(status)
        val browser = WebView(this)
        web = browser
        browser.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            userAgentString += " AgentC2Android/0.4.17"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false)
        browser.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (target.contains(uri.toString())) return false
                if (request.isForMainFrame) openExternal(uri)
                return true
            }
            override fun onPageFinished(view: WebView, url: String) { CookieManager.getInstance().flush() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError("Cannot reach desktop. Check Tailscale and that AgentC2 is running, then reconnect.")
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                showError("Desktop certificate is invalid. Check its HTTPS setup before reconnecting.")
            }
        }
        browser.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                if (!target.contains(view.url ?: "")) return false
                val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
                val popup = WebView(this@MainActivity)
                popups.add(popup)
                popup.settings.apply { allowFileAccess = false; allowContentAccess = false }
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        if (request.url.toString() == "about:blank") return false
                        if (request.isForMainFrame) openExternal(request.url)
                        android.os.Handler(mainLooper).post { popups.remove(popup); popup.destroy() }
                        return true
                    }
                }
                transport.webView = popup
                resultMsg.sendToTarget()
                return true
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                picker?.onReceiveValue(null)
                picker = null
                if (!target.contains(view.url ?: "")) { callback.onReceiveValue(null); return true }
                picker = callback
                try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "image/*" }, 7) }
                catch (_: ActivityNotFoundException) { callback.onReceiveValue(null); picker = null; showError("No image picker is installed.") }
                return true
            }
        }
        root.addView(browser, LinearLayout.LayoutParams(-1, 0, 1f))
        browser.loadUrl(target.url)
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme !in listOf("https", "http")) return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { showError("No browser is installed to open this link.") }
    }

    private fun showError(message: String) { status.text = message; status.visibility = View.VISIBLE }

    @Deprecated("Platform activity result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 7) {
            val result = if (resultCode == RESULT_OK && data?.data?.scheme == "content") arrayOf(data.data!!) else null
            picker?.onReceiveValue(result)
            picker = null
        }
    }

    override fun onResume() {
        super.onResume()
        web?.let { browser ->
            browser.onResume()
            if (connection!!.contains(browser.url ?: "")) {
                browser.evaluateJavascript("window.dispatchEvent(new Event('agentc2:foreground'))", null)
            }
        }
    }

    override fun onPause() {
        web?.onPause()
        super.onPause()
    }

    @Deprecated("Platform back callback for API 29 compatibility")
    override fun onBackPressed() {
        val browser = web
        if (browser == null) super.onBackPressed()
        else if (browser.canGoBack()) browser.goBack()
        else showConnection()
    }

    override fun onDestroy() {
        picker?.onReceiveValue(null)
        closePopups()
        web?.destroy()
        super.onDestroy()
    }
}
