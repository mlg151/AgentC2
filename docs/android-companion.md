# Android companion

AgentC2 v0.4.17 adds an Android 10+ companion APK. It uses the same phone-specific interface as the browser companion, served by the paired desktop. Keep AgentC2 running and the computer awake. Install Tailscale separately and connect both devices to your tailnet.

Download `AgentC2-0.4.17-android.apk` from the release, verify it against `SHA256SUMS.txt`, and allow installation from your chosen download app when Android prompts. Release APKs use a persistent signing key so a later APK can update the installation. Development APKs use a different key and cannot update a release installation.

In desktop Settings → Remote access, enable the existing HTTPS or private-IP transport and generate a pairing link. Paste that link into the Android connection screen. The app retains the desktop address and its private WebView cookies; it does not retain pairing tokens. You can change desktops, reconnect, or forget the connection from the native controls. Existing browser links and paired devices continue working.

## Phone workflows

Use **Tools** for settings/hosts/presets/OpOrders, Exercises, Flash Traffic, cleanup, Overwatch, and history search. Open a session and use **Session tools** for notes/projects, deletion, faults, SitRep, and worktree diffs. Session creation uses the same launch choices and permission profiles as desktop. Terminal/chat input and destructive session actions retain the existing Take control handoff. Opening or closing a phone view does not change desktop navigation or stop a session.

Clipboard operations use the phone clipboard. On private HTTP, browsers without clipboard APIs offer a paste prompt or a copy fallback. Terminal image selection converts the image to PNG and limits the transfer to 768 KiB; SSH credentials remain on the desktop. External links open in the phone browser. Foreground return refreshes state; actions whose outcome is uncertain are not automatically repeated. Background notifications are not part of this release.

## Isolated development previews

Development websites run on a separate origin from the companion. For the default gateway port 43127, configure an extra tailnet-only listener:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:43128
```

The local preview port is the gateway port plus one (65534 when the gateway uses 65535). If the companion already uses HTTPS 8443, use HTTPS 9443 for previews. Private-IP deployments instead forward tailnet TCP 8443 to the same local preview port:

```sh
tailscale serve --bg --tcp=8443 tcp://127.0.0.1:43128
```

Do not enable Funnel. The preview listener starts when a paired device opens a development URL. Preview handoffs expire after 60 seconds and are single-use; preview sessions expire after 15 minutes and stop working when the device is revoked. One preview destination is active per browser cookie jar; opening another destination replaces it for subsequent requests. Refresh by opening the URL again from AgentC2.

The proxy strips companion/authorization cookies, Tailscale identity headers, and upstream Set-Cookie/CORS overrides. It supports assets and WebSocket traffic, rewrites same-target redirects, and rejects external redirects and companion gateway paths. Development sites that require their own cookies or external redirects need a separately managed tailnet endpoint. No preview page receives Android native capabilities.

## Build and validation

Use Node 22, Java 21, Android SDK 36, and the checked-in Gradle wrapper:

```sh
npm ci
cd android
./gradlew testDebugUnitTest connectedDebugAndroidTest coverageReport verifyCoverage assembleDebug
```

An emulator/device must be connected for instrumentation tests. `verifyCoverage` requires 100% production Kotlin lines and branches, combining unit and device execution data. Browser/Node reports and the Android XML are merged by:

```sh
AGENTC2_JACOCO_REPORT=android/app/build/reports/jacoco/coverageReport/coverageReport.xml npm run coverage:collect
npm run coverage:check -- --base <comparison-commit>
```

PR checks compare against their merge base; release checks compare against the preceding release tag. Missing reports and uncovered changed lines/branches fail the gate. Generated/vendor code, declarations, and non-executable assets are excluded.

Release signing requires `AGENTC2_ANDROID_KEYSTORE`, `AGENTC2_ANDROID_STORE_PASSWORD`, `AGENTC2_ANDROID_KEY_ALIAS`, and `AGENTC2_ANDROID_KEY_PASSWORD`. GitHub Actions receives the key through `ANDROID_KEYSTORE_BASE64` and corresponding password/alias secrets. It refuses a release build without signing material, verifies the APK signature, and includes the APK/signing evidence in release checksums. Never commit the keystore or credentials.

On headless Linux, wrap coverage collection with `xvfb-run -a`; the suite includes actual Electron desktop checks. Gradle files contain declarative build configuration; standard AGP signing validation is exercised by the release task, and custom executable release logic lives in the covered Node scripts.
