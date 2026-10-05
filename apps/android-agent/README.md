# BRC Android Agent

Native Kotlin Android agent for Better Remote Commander.

## Status

Implementation roadmap: **13/13 stages complete**.

The agent targets Android API 36 with a minimum API of 26. It connects
outbound to the existing BRC relay, advertises Android-specific tools, and
uses Android's permission model rather than attempting to bypass it.

## Core capabilities

- Pairing, encrypted credential storage, relay WebSocket, heartbeat/reconnect
- Foreground persistent agent service and boot restart
- Permission/capability dashboard and dynamic capability reporting
- Device, battery, memory, storage, network, sensor and audio controls
- Filesystem operations and encrypted cross-device file transfer
- Accessibility UI tree, semantic actions, gestures, text input and global actions
- Accessibility screenshots and combined screenshot + semantic visual state
- App/package discovery, app/activity launch, intents and settings navigation
- Notifications, clipboard and media controls
- Contacts, phone/SMS and location tools when Android grants the required access
- Device Owner, Shizuku and optional root privilege adapters
- Local multi-step automation/job engine
- Camera/microphone capture with permission and visibility checks
- Owner-approved MediaProjection screen recording
- Android PackageInstaller integration with system confirmation
- Local security/audit log

## Security model

The release build denies cleartext network traffic. Pairing tokens are stored
encrypted with Android Keystore. The foreground service remains visible to the
device owner and includes a local Stop action. Sensitive remote-call arguments
are not written to the audit log.
Accessibility, notification access, screen capture, package
installation, camera/microphone access and other protected Android features
still require the platform's normal owner authorization. BRC does not silently
enable those permissions or bypass protected/secure surfaces.

Debug builds allow cleartext networking only for local emulator testing. The
debug-only ADB tool harness is not included in release builds.

## Build

From `apps/android-agent`:

```powershell
.\gradlew.bat clean testDebugUnitTest assembleDebug assembleRelease
```

Debug APK:

`app/build/outputs/apk/debug/app-debug.apk`

Release APK:

`app/build/outputs/apk/release/app-release-unsigned.apk`

### GitHub Actions release build

The repository includes `.github/workflows/android.yml`. It runs for Android
changes pushed to `main` or `feat/android-agent`, for pull requests that
change the Android app/workflow, and from manual `workflow_dispatch`.

The job installs JDK 21 and Android SDK/API 36, runs
`testDebugUnitTest assembleRelease`, verifies the release APK, prints its
SHA-256 checksum, and uploads it as:

`brc-android-release-<commit SHA>`

The workflow artifact is retained for 30 days.

The release artifact is intentionally unsigned in source control and CI. Sign
it with the deployment owner's Android signing key using Android Studio or the
Android SDK signing tools before distribution. Never commit a production
signing key or password to this repository.

## Recommended owner setup

For the strongest non-root configuration, enable the BRC foreground agent,
Accessibility, notification access, unrestricted battery usage, required
runtime permissions, and optionally Device Owner and Shizuku. Root remains an
optional higher-privilege mode and is not required for boot start or the
persistent relay connection.

## Source layout

Main Android code lives under:

`app/src/main/java/io/github/shahidx0x/brc/android/`

Debug-only validation components live under `app/src/debug/` and are excluded
from release APKs.
