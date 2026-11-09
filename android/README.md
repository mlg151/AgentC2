# AgentC2 Android companion

The Android application connects to the existing desktop companion gateway. The desktop and Android device must be connected to Tailscale; the desktop must stay running. Tailscale is a separate app. The existing web companion remains available.

On the desktop enable remote access, generate a pairing link, then paste that link into the Android connection screen. HTTPS `*.ts.net` origins and HTTP/HTTPS addresses in Tailscale's `100.64.0.0/10` range are accepted. Pairing credentials are consumed by the desktop; only the origin is saved natively. Cookies stay in the app's private WebView storage. "Forget device" clears local cookies and web storage. Revoke the paired device on the desktop to invalidate server authorization.

The companion page supplies the same workflows as the web companion. Android Back traverses page history, then returns to the connection screen. Returning from the background signals the shared companion to refresh authoritative server state while preserving its current page and drafts. Reconnect loads the companion entrypoint without replaying a prior request. Image attachment uses Android's document picker; clipboard actions use the WebView's normal, user-initiated web platform support. There is no native JavaScript bridge. Preview/external sites open in your browser. Invalid TLS certificates are never bypassed.

## Build and test

Install JDK 21, Android SDK platform/build tools 36, and accept Android SDK licenses. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the SDK path.

```sh
cd android
./gradlew assembleDebug testDebugUnitTest verifyCoverage
./gradlew connectedDebugAndroidTest coverageReport verifyCoverage
```

The checked-in Gradle wrapper pins Gradle 9.6.0 and verifies its SHA256. AGP is pinned to 9.4.1. `app/build/outputs/apk/debug/app-debug.apk` is installable for development. Minimum supported Android is 10/API 29. `coverageReport` merges unit `.exec` and instrumentation `.ec` execution data and writes `app/build/reports/jacoco/coverageReport/coverageReport.xml`; `verifyCoverage` requires 100% line and branch coverage across all production Kotlin, including the activity; the repository change-coverage gate also rejects missing source reports.

For release, provide a persistent keystore outside the repository and these environment variables:

- `AGENTC2_ANDROID_KEYSTORE`: absolute keystore path
- `AGENTC2_ANDROID_STORE_PASSWORD`
- `AGENTC2_ANDROID_KEY_ALIAS`
- `AGENTC2_ANDROID_KEY_PASSWORD`

Run `./gradlew assembleRelease`. Release packaging fails if any signing variable is absent. Never replace an existing release keystore: upgrades require the same signing key. CI must verify the release APK with `apksigner verify --verbose --print-certs` and publish a SHA256 checksum alongside `AgentC2-0.4.17-android.apk`. No signing secret is committed.
