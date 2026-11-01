# CrunchySpeed

A personal Android app that wraps the Crunchyroll website in a full-screen WebView and adds the
playback controls the official app is missing.

## Features

- **Playback speed menu**: 0.5x–2x in 0.25 steps. The chosen speed is remembered across episodes
  and app restarts. Speeds picked in Crunchyroll's own player menu are picked up too.
- **Phone-style taps**: the first tap only reveals the controls. Tap again to play or pause.
- **Double tap to skip**: the left half skips back 10 s and the right half skips forward 10 s.
  Keep tapping to skip further.
- **Centre controls**: back 10 / play-pause / forward 10, shown together with the player controls.
- **Fullscreen**: rotates to landscape, hides the system bars and keeps the screen on.

## How it works

- `MainActivity.kt` is a WebView locked to `*.crunchyroll.com`. Other links open in the default
  browser. It grants protected-media (Widevine) access to Crunchyroll only, and it handles
  fullscreen video.
- Crunchyroll's mobile site refuses to play on phones, so the app identifies as **desktop Chrome on
  Windows**. It sets the UA string, the UA client hints and `navigator.platform`. The viewport stays
  phone-sized.
- `assets/speed.js` is injected at document start into every Crunchyroll frame using
  `WebViewCompat.addDocumentStartJavaScript`. It adds the speed menu, the tap handling and the centre
  controls. It also fixes the desktop player's layout on a phone-sized screen: it clips sideways
  overflow, hides the volume button and scales the control bar to fit. The UI is mounted inside the
  player's `[data-testid="player-controls-root"]`, which keeps the player's own controls from
  auto-hiding when you tap the buttons.

## Build

Requires JDK 17 and the Android SDK (platform 35, build-tools 35).

```sh
# local.properties: sdk.dir=<path to Android SDK>
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug builds enable WebView remote debugging (`chrome://inspect`).

## Known limits

- Log in with email and password. Google and Apple sign-in are blocked inside WebViews.
- The site uses software Widevine (L3), so video quality may be lower than in the official app on
  some devices.
- The script depends on Crunchyroll's player markup (`data-testid` attributes). If the site
  changes, the script may need small updates.
- For personal use only. Not affiliated with Crunchyroll.
