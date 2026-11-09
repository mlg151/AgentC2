package android.webkit

/** Android exposes an abstract type with a package-private constructor. */
class TestWebResourceError : WebResourceError() {
    override fun getErrorCode() = -2
    override fun getDescription() = "unreachable"
}
