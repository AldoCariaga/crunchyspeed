# CrunchySpeed

> **Unofficial personal project.** Not affiliated with, endorsed by or sponsored by Crunchyroll.
> See [Disclaimer](#disclaimer).

A personal Android app that wraps the Crunchyroll website in a full-screen WebView and adds the
playback controls the official app is missing.

## Features

- **Playback speed menu**: 0.5x–2x in 0.25 steps. The chosen speed is remembered across episodes
  and app restarts. Speeds picked in Crunchyroll's own player menu are picked up too.
- **Phone-style taps**: a tap shows the controls and another tap hides them; tapping
  never pauses. Pause with the centre play button.
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

## Disclaimer

- This is a personal, non-commercial hobby project, shared as-is in case the code is useful to
  someone. It is **not affiliated with, endorsed by or sponsored by Crunchyroll, LLC** or its
  parent companies. "Crunchyroll" is a trademark of its owner. It is used here only to say which
  website the app works with.
- The repository contains no Crunchyroll code, video or other content. The app loads the public
  crunchyroll.com website, and you need your own Crunchyroll account (and subscription, where
  required).
- The app does not bypass DRM, paywalls or region restrictions, and it does not download, record
  or redistribute video. Playback runs through Crunchyroll's own player and Widevine DRM. The app
  only changes how the player looks and responds to taps on your device.
- Using a modified client may go against Crunchyroll's Terms of Service. Use it at your own risk.
  The software comes with no warranty (see [LICENSE](LICENSE)).
- If you represent Crunchyroll and have a concern about this project, please open an issue and it
  will be addressed promptly.

## License

[MIT](LICENSE)
