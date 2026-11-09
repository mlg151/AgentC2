package com.agentc2.companion

import android.content.Intent
import android.webkit.WebView
import android.widget.LinearLayout
import android.os.SystemClock
import android.view.MotionEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.widget.Button
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CompanionSmokeTest {
    private fun eventually(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15000
        while (SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            SystemClock.sleep(100)
        }
        fail(message)
    }

    private fun javascript(web: WebView, script: String): String? {
        val latch = CountDownLatch(1)
        var value: String? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            web.evaluateJavascript(script) { value = it; latch.countDown() }
        }
        assertTrue("WebView JavaScript callback timed out", latch.await(10, TimeUnit.SECONDS))
        return value
    }

    @Test fun realDocumentPickerAndRotationPreserveThePageAndDraft() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        lateinit var web: WebView
        instrumentation.runOnMainSync {
            activity.findViewById<EditText>(1).setText("https://desktop.tail.ts.net")
            activity.findViewById<Button>(2).performClick()
            val root = activity.findViewById<LinearLayout>(3)
            web = root.getChildAt(root.childCount - 1) as WebView
            web.loadDataWithBaseURL("https://desktop.tail.ts.net:443/", """
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <input id="image" type="file" accept="image/*" style="display:none">
                <button onclick="document.getElementById('image').click()" style="position:absolute;left:0;top:0;width:200px;height:100px">Choose image</button>
                <input id="draft" value="retained draft" style="position:absolute;left:0;top:120px">
            """.trimIndent(), "text/html", "UTF-8", "https://desktop.tail.ts.net:443/companion.html")
        }
        eventually("Fixture page did not load") { javascript(web, "document.getElementById('draft')?.value") == "\"retained draft\"" }
        instrumentation.runOnMainSync { assertTrue("Fixture must retain the trusted origin: ${web.url}", web.url!!.contains("desktop.tail.ts.net")) }
        val location = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(location) }
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, location[0] + 40f, location[1] + 40f, 0))
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down + 50, MotionEvent.ACTION_UP, location[0] + 40f, location[1] + 40f, 0))
        eventually("The real Android document picker did not open") {
            var pickerOpened = false
            instrumentation.runOnMainSync { pickerOpened = !activity.hasWindowFocus() }
            pickerOpened
        }
        android.os.ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_BACK")).use { it.readBytes() }
        eventually("Did not return from the document picker") {
            var focused = false
            instrumentation.runOnMainSync { focused = activity.hasWindowFocus() }
            focused
        }
        assertEquals("\"retained draft\"", javascript(web, "document.getElementById('draft').value"))
        instrumentation.runOnMainSync { activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        eventually("Activity did not rotate") { activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
        assertEquals("\"retained draft\"", javascript(web, "document.getElementById('draft').value"))
        instrumentation.runOnMainSync { activity.finish() }
    }

    @Test fun launchRejectsAnUntrustedDesktopAndAcceptsTailnetAddress() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(intent) as MainActivity
        instrumentation.runOnMainSync {
            activity.findViewById<Button>(5).performClick()
            val input = activity.findViewById<EditText>(1)
            input.setText("https://example.org")
            activity.findViewById<Button>(2).performClick()
            assertNotNull(input.error)
            input.setText("http://100.64.0.1:8787")
            activity.findViewById<Button>(2).performClick()
            assertEquals("http://100.64.0.1:8787", activity.getPreferences(0).getString("origin", ""))
            activity.findViewById<Button>(4).performClick()
            activity.findViewById<Button>(5).performClick()
            activity.finish()
        }
    }
}
