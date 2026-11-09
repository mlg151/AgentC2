package com.agentc2.companion

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class MainActivityTest {
    @Test fun connectRejectsPublicOriginsAndRemembersOnlySafeOrigin() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val input = activity.findViewById<EditText>(1)
        input.setText("https://evil.com")
        activity.findViewById<Button>(2).performClick()
        assertNotNull(input.error)
        val root = activity.findViewById<LinearLayout>(3)
        root.setPadding(0, 40, 0, 20)
        input.setText("https://desktop.tail.ts.net/companion.html#pair=secret")
        activity.findViewById<Button>(2).performClick()
        assertEquals("Connect must preserve safe system insets", 40, root.paddingTop)
        assertEquals(20, root.paddingBottom)
        assertEquals("https://desktop.tail.ts.net:443", activity.getPreferences(Activity.MODE_PRIVATE).getString("origin", ""))
        assertTrue(activity.findViewById<LinearLayout>(3).childCount > 0)
        activity.findViewById<Button>(4).performClick()
        assertEquals("https://desktop.tail.ts.net:443", activity.findViewById<EditText>(1).text.toString())
        activity.findViewById<Button>(5).performClick()
        assertEquals("", activity.getPreferences(Activity.MODE_PRIVATE).getString("origin", ""))
        activity.findViewById<EditText>(1).setText("http://100.64.0.1")
        activity.findViewById<Button>(2).performClick()
        activity.findViewById<Button>(4).performClick()
        activity.findViewById<EditText>(1).setText("https://other.tail.ts.net")
        activity.findViewById<Button>(2).performClick()
        assertEquals(setOf("http://100.64.0.1:80", "https://other.tail.ts.net:443"), activity.getPreferences(Activity.MODE_PRIVATE).getStringSet("origins", emptySet()))
        controller.pause().stop().destroy()
    }
}
