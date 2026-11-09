# SCALVS.ai phone app (Android and iOS)

A Capacitor app that opens https://scalvs.app full screen, with the SCALVS icon,
splash screen, microphone permission for voice input, and an offline page.
Because it loads the live site, every deploy of scalvs.app updates the app too.
Only native changes (icon, permissions, version) need a new app build.

Links to other sites, including the other Infinitum products, open in the phone's
browser, so the app never gets stuck on another site.

App id: `app.scalvs` · Name: SCALVS.ai

## iPhone and iPad (needs a Mac)

1. Install Xcode from the App Store and Node.js 22 (https://nodejs.org).
2. Get the code and install:
   ```bash
   git clone https://github.com/InfinitumCorp/scalvs-ai.git
   cd scalvs-ai/mobile
   npm ci
   npx cap sync ios
   npx cap open ios
   ```
3. In Xcode, select the **App** target → **Signing & Capabilities** → tick
   *Automatically manage signing* and pick your **Team** (sign in with your Apple ID
   under Xcode → Settings → Accounts). A free Apple ID works for your own iPhone
   (the app then expires after 7 days); the App Store needs the Apple Developer
   Program ($99/year).
4. **Your own iPhone:** plug it in, unlock it, choose it at the top of Xcode and
   press ▶ Run. The first time, on the iPhone open Settings → General → VPN & Device
   Management and trust your developer certificate; also turn on Settings → Privacy &
   Security → Developer Mode if asked.
5. **App Store / TestFlight:** choose *Any iOS Device (arm64)*, then
   Product → Archive → Distribute App → App Store Connect → Upload. Create the app
   in https://appstoreconnect.apple.com first with bundle id `app.scalvs`.

## Android

```bash
cd mobile
npm ci
npm run android:debug        # → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Play Store builds need a signing key. Make one once and keep it safe (losing it
means you can't update the app):

```bash
keytool -genkeypair -v -keystore scalvs-release.keystore -alias scalvs -keyalg RSA -keysize 2048 -validity 10000
```

Then build with these environment variables set: `SCALVS_KEYSTORE_FILE`,
`SCALVS_KEYSTORE_PASSWORD`, `SCALVS_KEY_ALIAS`, `SCALVS_KEY_PASSWORD`, and run
`npm run android:release` (→ `.aab` for Play Console, `.apk` for direct installs).

## Cloud builds

`.github/workflows/mobile.yml` builds the Android APK and checks the iOS build on
every `mobile-v*` tag (or by hand from the Actions tab). Add the secrets
`ANDROID_KEYSTORE_BASE64` (`base64 -w0 scalvs-release.keystore`),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` to get a
signed Play Store bundle too.

## Changing icons

Icons come from `../public/icons`. After changing them run `npm run assets`, then
`npx cap sync`.
