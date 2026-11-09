package com.agentc2.companion

import org.junit.Assert.*
import org.junit.Test

class ConnectionPolicyTest {
    @Test fun acceptsTailscaleHttpsAndPrivateCgnatOnly() {
        assertEquals("https://desktop.tail123.ts.net:443/companion.html", ConnectionPolicy.parse(" https://desktop.tail123.ts.net ")?.url)
        assertEquals("http://100.64.0.1:8787/companion.html#pair=abc_123-", ConnectionPolicy.parse("http://100.64.0.1:8787/companion.html#pair=abc_123-")?.url)
        assertNotNull(ConnectionPolicy.parse("http://100.127.255.254"))
        assertNotNull(ConnectionPolicy.parse("https://100.64.0.1"))
        assertNotNull(ConnectionPolicy.parse("https://desktop.tail.ts.net/"))
        assertNull(ConnectionPolicy.parse("http://101.64.0.1"))
        assertNull(ConnectionPolicy.parse("ftp://100.64.0.1"))
        assertNull(ConnectionPolicy.parse("https://user@a.ts.net"))
        assertTrue(ConnectionPolicy.parse("http://100.64.0.1")!!.contains("http://100.64.0.1/"))
        listOf("https://bad host.ts.net", "", "oops", "https://example.com", "http://desktop.tail.ts.net", "https://eviltailscale.net", "http://100.63.0.1", "http://100.128.0.1", "http://100.64.256.1", "http://100.064.0.1", "https://a.ts.net@evil.com", "https://a.ts.net?x=1", "https://a.ts.net/evil", "https://a.ts.net#evil", "https://a.ts.net#pair=", "https://a.ts.net:0", "https://a.ts.net:65536", "javascript:alert(1)", "file:///tmp/a").forEach { assertNull(it, ConnectionPolicy.parse(it)) }
    }
    @Test fun navigationIsExactOriginAndRejectsCredentials() {
        val c = ConnectionPolicy.parse("https://desktop.tail.ts.net")!!
        assertTrue(c.contains("https://desktop.tail.ts.net/companion.html?x=1"))
        assertFalse(c.contains("https://desktop.tail.ts.net:8443/"))
        assertFalse(c.contains("http://desktop.tail.ts.net/"))
        assertFalse(c.contains("https://other.tail.ts.net/"))
        assertFalse(c.contains("https://user@desktop.tail.ts.net/"))
        assertFalse(c.contains("not a URI"))
    }
}
