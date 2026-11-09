package com.agentc2.companion

import java.net.URI

/** Only a Tailscale address can become a privileged companion origin. No DNS lookup. */
class ConnectionPolicy private constructor(val origin: String, val url: String) {
    fun contains(candidate: String): Boolean {
        return try {
            val uri = URI(candidate)
            uri.rawUserInfo == null && canonicalOrigin(uri) == origin
        } catch (_: Exception) { false }
    }

    companion object {
        private fun canonicalOrigin(uri: URI): String {
            val port = if (uri.port == -1) { if (uri.scheme == "https") 443 else 80 } else uri.port
            return "${uri.scheme}://${uri.host}:$port"
        }

        fun parse(input: String): ConnectionPolicy? {
            return try {
                val uri = URI(input.trim())
                val host = uri.host ?: return null
                val octet = "(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])"
                val privateIp = host.matches(Regex("100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.$octet\\.$octet"))
                val secureTailnet = uri.scheme == "https" && host.matches(Regex("[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*\\.ts\\.net"))
                if (!(secureTailnet || privateIp && uri.scheme in listOf("http", "https"))) return null
                if (uri.rawUserInfo != null || uri.rawQuery != null || uri.port == 0 || uri.port > 65535) return null
                if (uri.path !in listOf("", "/", "/companion.html")) return null
                val fragment = uri.rawFragment
                if (fragment != null && !fragment.matches(Regex("pair=[a-zA-Z0-9_-]{1,200}"))) return null
                val origin = canonicalOrigin(uri)
                ConnectionPolicy(origin, "$origin/companion.html" + if (fragment == null) "" else "#$fragment")
            } catch (_: Exception) { null }
        }
    }
}
