# BRC Android Agent

A native Kotlin Android agent for Better Remote Commander. It pairs with your relay like the desktop agent,
keeps an outbound WebSocket open, and exposes Android-specific tools to Claude and ChatGPT.

> **Availability:** the code lives in `apps/android-agent/` on the `feat/android-agent` branch and is not yet
> merged into `main`. Check out that branch to build it. The authoritative app README is
> `apps/android-agent/README.md` on that branch.

- Target API 36, minimum API 26.
- Uses Android's permission model. It does not silently enable or bypass protected permissions.
- Tool names are prefixed `android_` (except the shared file transfer tools).

## How it works

1. Open the app, enter your relay URL and pair. You approve the device at `/device/verify` as usual.
2. The credential is stored encrypted with the Android Keystore.
3. A visible foreground service keeps the relay WebSocket alive, with heartbeat and reconnect. It restarts on boot
   and has a local Stop action.
4. The agent advertises only the tools whose permissions are currently granted (capability manager).
5. The relay merges these tools with those of your other devices. Use `deviceId` to target the phone.

## Capabilities and tools

| Area | Tools |
| --- | --- |
| Core | `android_ping`, `android_get_capabilities`, `android_privilege_status` |
| Device info | `android_device_info`, `android_battery`, `android_memory`, `android_storage`, `android_network`, `android_bluetooth_info`, `android_list_sensors`, `android_orientation` |
| Audio, display, haptics | `android_get_volume`, `android_set_volume`, `android_get_brightness`, `android_set_brightness`, `android_set_screen_timeout`, `android_vibrate` |
| Files | `android_file_roots`, `android_list_files`, `android_read_file`, `android_write_file`, `android_copy_file`, `android_move_file`, `android_delete_file`, `android_file_info`, `android_search_files` |
| Encrypted file transfer | `prepare_file_transfer`, `send_file_transfer`, `receive_file_transfer` (same protocol as the desktop agent) |
| UI automation (Accessibility) | `android_ui_tree`, `android_find_element`, `android_click_element`, `android_click_coordinate`, `android_long_press`, `android_swipe`, `android_scroll`, `android_input_text`, `android_focus`, `android_back`, `android_home`, `android_recents`, `android_notifications_panel`, `android_quick_settings`, `android_power_dialog` |
| Screen | `android_screenshot`, `android_visual_state` (screenshot plus semantic UI state) |
| Apps and intents | `android_list_apps`, `android_app_info`, `android_open_app`, `android_close_app`, `android_open_activity`, `android_open_intent`, `android_open_url`, `android_open_app_settings`, `android_open_settings`, `android_open_setting`, `android_get_setting`, `android_set_setting` |
| App install | `android_install_apk`, `android_install_status`, `android_uninstall_app` (system confirmation required) |
| Notifications | `android_get_notifications`, `android_open_notification`, `android_dismiss_notification`, `android_notification_action`, `android_reply_notification` |
| Clipboard and media | `android_get_clipboard`, `android_set_clipboard`, `android_media_sessions`, `android_media_control` |
| Contacts | `android_get_contacts`, `android_search_contacts`, `android_create_contact` |
| Phone and SMS | `android_dial`, `android_make_call`, `android_answer_call`, `android_end_call`, `android_call_state`, `android_get_call_log`, `android_read_sms`, `android_search_sms`, `android_send_sms` |
| Location | `android_get_location`, `android_location_providers` |
| Capture | `android_camera_info`, `android_camera_capture`, `android_record_audio`, `android_request_screen_projection`, `android_screen_projection_status`, `android_start_screen_recording`, `android_stop_screen_recording` |
| Automation jobs | `android_start_task`, `android_task_status`, `android_task_events`, `android_cancel_task` (local multi-step job engine) |
| Privileged modes | `android_shell`, `android_shizuku_request_permission`, `android_device_owner_set_camera_disabled`, `android_device_owner_set_global_setting`, `android_device_owner_set_keyguard_disabled`, `android_device_owner_set_lock_screen_info`, `android_device_owner_set_permission`, `android_device_owner_set_status_bar_disabled`, `android_device_owner_set_user_restriction` |
| Audit | `android_audit_log`, `android_clear_audit_log` |

Availability of each tool depends on granted permissions and the active privilege mode.

## Privilege modes

- **Standard**: normal runtime permissions plus Accessibility and Notification access.
- **Shizuku**: optional, for shell-level operations.
- **Device Owner**: optional, enables the `android_device_owner_*` tools.
- **Root**: optional, higher-privilege adapter. Not needed for boot start or the persistent connection.

## Security model

- Release builds deny cleartext traffic. Debug builds allow it only for local emulator testing.
- Pairing tokens are encrypted with the Android Keystore.
- The foreground service is always visible to the device owner and has a local Stop action.
- Sensitive call arguments are not written to the local audit log.
- Accessibility, notification access, screen capture, package install and camera/microphone access still need
  the owner's normal Android authorization. BRC does not bypass secure surfaces.
- The debug-only ADB tool harness is excluded from release APKs.

## Recommended owner setup

Enable the BRC foreground agent, Accessibility, notification access, unrestricted battery usage and the required
runtime permissions. Optionally add Shizuku or Device Owner.

## Build

From `apps/android-agent` on the `feat/android-agent` branch:

```powershell
.\gradlew.bat clean testDebugUnitTest assembleDebug assembleRelease
```

- Debug APK: `app/build/outputs/apk/debug/app-debug.apk`
- Release APK: `app/build/outputs/apk/release/app-release-unsigned.apk`

### GitHub Actions

`.github/workflows/android.yml` builds on Android changes pushed to `main` or `feat/android-agent`, on pull
requests touching the app, and on manual dispatch. It installs JDK 21 and the Android SDK for API 36, runs
`testDebugUnitTest assembleRelease`, prints the APK SHA-256 and uploads `brc-android-release-<commit SHA>`
(kept 30 days).

The release APK is unsigned. Sign it with your own key before distribution and never commit signing keys.

## Source layout

`app/src/main/java/io/github/shahidx0x/brc/android/` is split by area: `core`, `transport`, `tools`,
`accessibility`, `files`, `apps`, `notifications`, `clipboard`, `media`, `contacts`, `telephony`, `location`,
`capture`, `projection`, `install`, `privilege`, `automation`, `audit`, `permissions`, `service`, `receiver`,
`storage`, `protocol`. Debug-only validation code is in `app/src/debug/`.
