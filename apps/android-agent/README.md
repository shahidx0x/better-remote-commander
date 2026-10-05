# BRC Android Agent

Native Kotlin Android agent for Better Remote Commander.

## Stage 1 scope

- Android application foundation
- BRC protocol/version model
- Persistent device identity
- Capability snapshot model
- Tool registry and dispatcher
- Local `android_ping` self-check
- API 36 target

## Build

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug
```

The debug APK is written under `app/build/outputs/apk/debug/`.

## Current architecture

The Android app is intentionally separate from the pnpm workspace.
Relay connectivity, permissions, foreground runtime, and Android
automation capabilities are added in later stages.
