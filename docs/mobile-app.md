# REEP as a phone app (Android + iOS)

The phone app is **the same Angular website**, packed into an Android/iOS app
by **Capacitor** and drawn with **Ionic** components so it looks like a phone
app. Nothing was rewritten: every screen, service, API call and route is the
website's own code.

```
apps/web/
  src/                    the website (unchanged screens)
  src/app/native/         code that runs ONLY inside the app
  src/app/layout/mobile-shell.*   the app's frame: menu, header, bottom tabs
  src/environments/native.ts      which server the app talks to   <- you edit this
  src/ionic.scss          Ionic's styles (loaded only inside the app)
  capacitor.config.ts     app name, app ID, splash screen, status bar
  resources/              the big source images for the icon and splash
  android/                the Android Studio project (generated, committed)
  ios/                    the Xcode project (generated, committed; needs a Mac)
  scripts/build-apk.mjs   `npm run mobile:apk`
```

---

## 1. One-time setup on the server

The app is a different "site" from the website as far as the server is
concerned (the app runs at `https://localhost` on the phone). Tell the API to
accept it — one line in `apps/api-py/.env` (or, in production, the API's
environment variables):

```
NATIVE_APP_ORIGINS="https://localhost,capacitor://localhost"
```

Restart the API. Without this line the app opens, but every screen says it
could not load.

## 2. One-time setup on your computer

1. **Node.js 24** — https://nodejs.org (the "LTS" button). Angular needs
   22.22.3 or newer.
2. **Android Studio** — https://developer.android.com/studio. Install it with
   the default options. The first time it opens it shows a "Setup Wizard":
   click **Next** on every page, accept the licences, and let it download (it
   installs the Android SDK and Java for you — about 3 GB).
3. In a terminal:
   ```
   cd apps/web
   npm ci
   ```

## 3. Point the app at your server

Open `apps/web/src/environments/native.ts` and fill in your REEP address, the
same one you open the website on, **no `/api` and no `/` at the end**:

```ts
export const native = {
  apiOrigin: 'https://reep.example.edu',
};
```

It must be `https://`. Android blocks the app from calling a plain `http://`
address (see "Why something works on the web but not in the app" below).

## 4. Run it on your phone

**Prepare the phone (once):**

1. On the phone: **Settings → About phone** → tap **Build number** seven times
   until it says "You are now a developer".
2. **Settings → System → Developer options** → turn on **USB debugging**.
3. Plug the phone into the computer with a USB cable. On the phone, a box asks
   "Allow USB debugging?" → tick **Always allow** → **Allow**.

**Every time:**

```
cd apps/web
npm run mobile:android
```

That builds the website, copies it into the Android project, and opens it in
Android Studio. In Android Studio:

1. Wait until the bar at the bottom stops saying "Gradle sync…" (first time:
   a few minutes).
2. At the top, in the device drop-down next to the green ▶ button, pick your
   phone's name.
3. Click the green **▶ Run** button. The app installs and opens on the phone.

Shortcut once that works: `npm run mobile:run` builds and installs straight
onto the plugged-in phone without opening Android Studio (it asks you to pick
the device in the terminal).

**After you change code:** run `npm run mobile:android` again (or
`mobile:run`) — the phone only gets what was built.

## 5. Build an APK (a file you can send to any Android phone)

**Option A — on your computer:**

```
cd apps/web
npm run mobile:apk
```

The file is `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`.
Copy it to a phone (WhatsApp, Google Drive, USB) and open it there. Android
asks to allow "Install unknown apps" for the app you opened it from — allow
it once.

**Option B — Android Studio's menus:** **Build → Generate App Bundles or APKs
→ Generate APKs**. When it finishes, a box in the corner says "APK(s)
generated" → click **locate**.

**Option C — on GitHub, no Android Studio at all:** **Actions → "Android APK
(debug)" → Run workflow**, type your server address, press **Run workflow**.
After ~10 minutes, open the finished run and download **reep-debug-apk**.
(GitHub only shows this button once the workflow file is on the `main`
branch.)

These are **debug** APKs: right for testing, not for the Play Store. A Play
Store upload needs a *release* build signed with your own key (Android Studio:
**Build → Generate Signed App Bundle or APK**), and the key must be kept safe
forever — losing it means you can never update the app.

## 6. iOS

Building for iPhone needs a **Mac with Xcode** (Apple's rule). On the Mac:

```
cd apps/web
npm ci
npm run mobile:ios
```

Xcode opens. Click **App** in the left list → **Signing & Capabilities** →
pick your Apple ID under **Team** → choose your iPhone at the top → ▶.

## 7. Changing the icon or the splash screen

The source images are in `apps/web/resources/` (`icon-only.png`,
`icon-foreground.png`, `icon-background.png`, `splash.png`). Replace them with
your own (same sizes), or redraw REEP's with
`python tools/icons/make-native-icons.py`, then:

```
cd apps/web
npm run mobile:icons
```

---

## What changed, in plain words

| You asked for | Where it is |
|---|---|
| Ionic + Capacitor added, nothing rewritten | `package.json`, `capacitor.config.ts`, `android/`, `ios/` |
| Ionic layout (`ion-menu`, `ion-header`, `ion-content`, `ion-list`, tab bar) | `src/app/layout/mobile-shell.component.*` — used **only inside the app**; the website keeps its own layout |
| Phone-friendly | the Ionic frame above, plus the website's existing phone layout for every screen |
| Services, API calls, routing keep working | `src/app/native/native-fetch.ts` sends every `/api/...` call to the server with the sign-in token; routes are untouched |
| Back button | `native-bootstrap.ts` → `wireBackButton`: closes the menu, goes back a screen, or puts the app in the background on a home screen |
| Safe areas (notch, status bar, gesture bar) | Ionic's header and tab bar pad themselves; `viewport-fit=cover` is set inside the app; `SystemBars` in `capacitor.config.ts` |
| Splash screen | `capacitor.config.ts` (`SplashScreen`), hidden when the first screen is ready |
| App icon | `resources/` → `npm run mobile:icons` |
| Status bar | dark icons on REEP's light header (`StatusBar`) |
| Token in Capacitor Preferences | `src/app/native/token-store.ts` |

### How the sign-in works in the app

On the website the server keeps you signed in with a **cookie** the browser
holds and JavaScript can never read. The app cannot use that cookie: to the
server the app is a different site, and browsers do not send one site's
cookie to another.

So inside the app:

1. You type email + password as usual.
2. The server sees the request comes from the app (its `Origin` is
   `https://localhost`, listed in `NATIVE_APP_ORIGINS`) and also returns the
   **same sign-in token** in the reply. A normal browser never gets it.
3. The app saves it with **Capacitor Preferences** (the phone's own app
   storage — not `localStorage`, which Android and iOS may wipe when the phone
   is low on space).
4. Every request then carries `Authorization: Bearer <token>`. The server
   checks it exactly like the cookie, so "one device at a time", sign-out and
   disabled accounts all work the same.

## Why something works on the web but not in the app

| What you see in the app | Why | What to do |
|---|---|---|
| Every screen: "could not load" | `apiOrigin` is blank in `native.ts`, or the server does not list the app in `NATIVE_APP_ORIGINS` | Fill both in (steps 1 and 3). |
| Same, and `apiOrigin` starts with `http://` | The app runs at `https://localhost`; Android blocks `https` pages from calling `http` ("mixed content") | Use the `https://` address. |
| No "Continue with Google" button | Google refuses sign-in from inside apps' built-in browsers (`disallowed_useragent`), and its reply would come back to the server, not the phone | Sign in with email + password in the app. |
| Mock interview will not connect | The interview uses a live connection (WebSocket) that only carries the cookie, and checks it comes from the website's address | Use the website for mock interviews for now. Making it work needs the server to accept the app's token on that connection — a follow-up. |
| A download button (CSV, PDF) does nothing | Plain download links are opened by the phone's web view directly, without the sign-in token | Use the website for downloads for now. |
| Signed out after signing in on a laptop | REEP allows one device at a time — on purpose | Sign in again. |
| Android: Back closes the app on the home screen | That is normal Android behaviour on the first screen (it goes to the background) | — |

## Commands at a glance

```
cd apps/web
npm ci                     # first time, and after package.json changes
npm run mobile:android     # build + open in Android Studio
npm run mobile:run         # build + install on the plugged-in phone
npm run mobile:apk         # build the APK file
npm run mobile:ios         # build + open in Xcode (Mac only)
npm run mobile:icons       # regenerate icons/splash from resources/
```
