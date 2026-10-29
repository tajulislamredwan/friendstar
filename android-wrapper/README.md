# FriendStar Android wrapper

A native Android WebView shell for the existing live FriendStar service. It loads only `https://chat.friendstar.workers.dev/`, keeps the existing web application and server as-is, supports uploads through Android's file picker, and asks Android for camera/microphone permission when the trusted live app requests WebRTC access.

## Build a free debug APK

Requirements: JDK 17 or newer and Android SDK platform 35/build-tools 35.0.0.

```bash
cd android-wrapper
./gradlew assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`. The debug build uses Android Gradle's free debug signing key. It is suitable for sideloading/testing, not a Play Store release or a permanent production signing identity.

The APK requires internet access and displays the current live site; the web app is not bundled offline. Android WebView does not provide reliable support for browser web-push notifications, so use FriendStar's in-app alerts. Voice/video calling requires the user to grant Android camera and/or microphone access. Minimum Android version: 6.0 (API 23).
