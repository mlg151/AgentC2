package com.agentc2.companion

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.view.View
import android.webkit.*
import android.widget.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class BrowserBehaviorTest {
    private fun connect(activity: MainActivity): WebView {
        activity.findViewById<EditText>(1).setText("https://desktop.tail.ts.net/companion.html#pair=abc")
        activity.findViewById<Button>(2).performClick()
        val root = activity.findViewById<LinearLayout>(3)
        return root.getChildAt(root.childCount - 1) as WebView
    }
    private fun request(url: String, main: Boolean = true) = object : WebResourceRequest {
        override fun getUrl() = Uri.parse(url)
        override fun isForMainFrame() = main
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders() = emptyMap<String, String>()
    }
    private val params = object : WebChromeClient.FileChooserParams() {
        override fun getMode() = MODE_OPEN
        override fun getAcceptTypes() = arrayOf("image/*")
        override fun isCaptureEnabled() = false
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent(Intent.ACTION_OPEN_DOCUMENT)
    }
    @Test fun browserStaysScopedAndBackResumeReconnectRefreshAuthoritativeState() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        val shadow = shadowOf(web)
        assertEquals("https://desktop.tail.ts.net:443/companion.html#pair=abc", shadow.lastLoadedUrl)
        assertFalse(web.settings.allowFileAccess)
        assertFalse(web.settings.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, web.settings.mixedContentMode)
        val client = shadow.webViewClient
        assertFalse(client.shouldOverrideUrlLoading(web, request("https://desktop.tail.ts.net/a")))
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://example.org")))
        assertEquals("https://example.org", shadowOf(activity).nextStartedActivity.data.toString())
        assertTrue(client.shouldOverrideUrlLoading(web, request("http://example.org")))
        assertEquals("http://example.org", shadowOf(activity).nextStartedActivity.data.toString())
        assertTrue(client.shouldOverrideUrlLoading(web, request("intent://evil")))
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://evil.org", false)))
        assertNull(shadowOf(activity).nextStartedActivity)
        client.onPageFinished(web, web.url!!)
        activity.findViewById<Button>(6).performClick()
        assertEquals("https://desktop.tail.ts.net:443/companion.html", shadow.lastLoadedUrl)
        controller.pause().resume()
        assertEquals(0, shadow.reloadInvocations)
        assertEquals("window.dispatchEvent(new Event('agentc2:foreground'))", shadow.lastEvaluatedJavascript)
        assertTrue(shadow.wasOnPauseCalled())
        assertTrue(shadow.wasOnResumeCalled())
        shadow.setCanGoBack(true)
        activity.onBackPressed()
        assertEquals(1, shadow.goBackInvocations)
        shadow.setCanGoBack(false)
        activity.onBackPressed()
        assertTrue(shadow.wasDestroyCalled())
        activity.onBackPressed()
        assertTrue(activity.isFinishing)
        controller.pause().stop().destroy()
    }
    @Test fun networkFailuresAndInvalidCertificatesShowActionableErrors() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        val client = shadowOf(web).webViewClient
        val root = activity.findViewById<LinearLayout>(3)
        val status = root.getChildAt(1) as TextView
        val error = TestWebResourceError()
        client.onReceivedError(web, request("https://desktop.tail.ts.net/a", false), error)
        assertEquals(View.GONE, status.visibility)
        client.onReceivedError(web, request("https://desktop.tail.ts.net/a"), error)
        assertTrue(status.text.contains("Tailscale"))
        val handler = ReflectionHelpers.callConstructor(SslErrorHandler::class.java)
        client.onReceivedSslError(web, handler, SslError(SslError.SSL_UNTRUSTED, (ReflectionHelpers.getStaticField<sun.misc.Unsafe>(sun.misc.Unsafe::class.java, "theUnsafe").allocateInstance(android.net.http.SslCertificate::class.java) as android.net.http.SslCertificate), "https://desktop.tail.ts.net"))
        assertTrue(shadowOf(handler).wasCancelCalled())
        assertFalse(shadowOf(handler).wasProceedCalled())
        assertTrue(status.text.contains("certificate"))
        activity.findViewById<Button>(6).performClick()
        assertEquals(View.GONE, status.visibility)
        shadowOf(RuntimeEnvironment.getApplication()).checkActivities(true)
        client.shouldOverrideUrlLoading(web, request("https://unavailable.example"))
        assertTrue(status.text.contains("browser"))
        controller.pause().stop().destroy()
    }
    @Test fun imagePickerReturnsOnlyContentUrisAndCancelsReplacedCallbacks() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        val chrome = shadowOf(web).webChromeClient
        var first: Array<Uri>? = arrayOf(Uri.EMPTY)
        assertTrue(chrome.onShowFileChooser(web, { first = it }, params))
        assertEquals("image/*", shadowOf(activity).nextStartedActivityForResult.intent.type)
        var result: Array<Uri>? = null
        chrome.onShowFileChooser(web, { result = it }, params)
        assertNull(first)
        shadowOf(activity).callOnActivityResult(7, Activity.RESULT_OK, Intent().setData(Uri.parse("content://media/photo/1")))
        assertEquals("content://media/photo/1", result!![0].toString())
        controller.pause().resume()
        assertEquals("Returning from the picker must not reload and cancel the image upload", 0, shadowOf(web).reloadInvocations)
        controller.pause().resume()
        assertEquals(0, shadowOf(web).reloadInvocations)
        listOf(Intent(), Intent().setData(Uri.parse("file:///sdcard/a.png"))).forEach { data ->
            result = arrayOf(Uri.EMPTY)
            chrome.onShowFileChooser(web, { result = it }, params)
            shadowOf(activity).callOnActivityResult(7, Activity.RESULT_OK, data)
            assertNull(result)
        }
        result = arrayOf(Uri.EMPTY)
        chrome.onShowFileChooser(web, { result = it }, params)
        shadowOf(activity).callOnActivityResult(7, Activity.RESULT_CANCELED, null)
        assertNull(result)
        shadowOf(activity).callOnActivityResult(8, Activity.RESULT_OK, null)
        shadowOf(activity).callOnActivityResult(7, Activity.RESULT_OK, null)
        val emptyWeb = WebView(activity)
        var emptyResult: Array<Uri>? = arrayOf(Uri.EMPTY)
        chrome.onShowFileChooser(emptyWeb, { emptyResult = it }, params)
        assertNull(emptyResult)
        emptyWeb.destroy()
        web.loadUrl("https://evil.org")
        result = arrayOf(Uri.EMPTY)
        chrome.onShowFileChooser(web, { result = it }, params)
        assertNull(result)
        web.loadUrl("https://desktop.tail.ts.net")
        chrome.onShowFileChooser(web, { result = it }, params)
        controller.pause().stop().destroy()
        assertNull(result)
        assertTrue(shadowOf(web).wasDestroyCalled())
    }
    @Test fun newWindowsOpenSafeExternalLinksWithoutGainingCompanionCapabilities() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        val chrome = shadowOf(web).webChromeClient
        val message = android.os.Message.obtain(android.os.Handler(android.os.Looper.getMainLooper()))
        val transport = web.WebViewTransport()
        message.obj = transport
        assertTrue(chrome.onCreateWindow(web, false, false, message))
        val popup = transport.webView!!
        assertFalse(popup.settings.javaScriptEnabled)
        assertFalse(popup.settings.allowFileAccess)
        assertFalse(popup.settings.allowContentAccess)
        val client = shadowOf(popup).webViewClient
        assertFalse(client.shouldOverrideUrlLoading(popup, request("about:blank")))
        assertTrue(client.shouldOverrideUrlLoading(popup, request("https://preview.example")))
        assertEquals("https://preview.example", shadowOf(activity).nextStartedActivity.data.toString())
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue(shadowOf(popup).wasDestroyCalled())
        val message2 = android.os.Message.obtain(android.os.Handler(android.os.Looper.getMainLooper()))
        val transport2 = web.WebViewTransport()
        message2.obj = transport2
        assertTrue(chrome.onCreateWindow(web, false, true, message2))
        val unsafePopup = transport2.webView!!
        assertTrue(shadowOf(unsafePopup).webViewClient.shouldOverrideUrlLoading(unsafePopup, request("intent://evil")))
        assertNull(shadowOf(activity).nextStartedActivity)
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue(shadowOf(unsafePopup).wasDestroyCalled())
        val frameMessage = android.os.Message.obtain(android.os.Handler(android.os.Looper.getMainLooper()))
        val frameTransport = web.WebViewTransport()
        frameMessage.obj = frameTransport
        chrome.onCreateWindow(web, false, false, frameMessage)
        val framePopup = frameTransport.webView!!
        shadowOf(framePopup).webViewClient.shouldOverrideUrlLoading(framePopup, request("https://iframe.example", false))
        assertNull(shadowOf(activity).nextStartedActivity)
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue(shadowOf(framePopup).wasDestroyCalled())
        val pendingMessage = android.os.Message.obtain(android.os.Handler(android.os.Looper.getMainLooper()))
        val pendingTransport = web.WebViewTransport()
        pendingMessage.obj = pendingTransport
        chrome.onCreateWindow(web, false, false, pendingMessage)
        val pendingPopup = pendingTransport.webView!!
        assertFalse(chrome.onCreateWindow(web, false, false, android.os.Message.obtain()))
        web.loadUrl("https://evil.org")
        assertFalse(chrome.onCreateWindow(web, false, false, message))
        val emptyWeb = WebView(activity)
        assertFalse(chrome.onCreateWindow(emptyWeb, false, false, message))
        emptyWeb.destroy()
        controller.pause().stop().destroy()
        assertTrue(shadowOf(pendingPopup).wasDestroyCalled())
    }
    @Test fun foregroundRefreshNeverEvaluatesScriptOutsidePairedOrigin() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        web.loadUrl("https://evil.org")
        controller.pause().resume()
        assertNull(shadowOf(web).lastEvaluatedJavascript)
        val pendingWeb = WebView(activity)
        ReflectionHelpers.setField(activity, "web", pendingWeb)
        controller.pause().resume()
        assertNull(shadowOf(pendingWeb).lastEvaluatedJavascript)
        web.destroy()
        controller.pause().stop().destroy()
    }
    @Test fun changingDesktopCancelsAnyOpenImagePickerOnce() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        var deliveries = 0
        shadowOf(web).webChromeClient.onShowFileChooser(web, { deliveries++ }, params)
        activity.findViewById<Button>(4).performClick()
        assertEquals(1, deliveries)
        shadowOf(activity).callOnActivityResult(7, Activity.RESULT_CANCELED, null)
        assertEquals(1, deliveries)
        controller.pause().stop().destroy()
    }
    @Test fun missingImagePickerFailsWithoutLeavingAnUnresolvedCallback() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val web = connect(activity)
        shadowOf(RuntimeEnvironment.getApplication()).checkActivities(true)
        var result: Array<Uri>? = arrayOf(Uri.EMPTY)
        shadowOf(web).webChromeClient.onShowFileChooser(web, { result = it }, params)
        assertNull(result)
        val status = activity.findViewById<LinearLayout>(3).getChildAt(1) as TextView
        assertTrue(status.text.contains("picker"))
        controller.pause().stop().destroy()
    }
}
