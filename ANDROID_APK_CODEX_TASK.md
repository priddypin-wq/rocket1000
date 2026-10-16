# rocket1000 — Android APK implementation task for Codex

**Goal:** Produce an installable Android APK for the existing rocket1000 MT5 trading companion app, retaining the current backend and Expert Advisor architecture. Prepare a debug APK for private device testing; do not publish or enable live trades as part of this task.

## Important repository finding

As of 2026-10-16, this GitHub repository's `main` branch contains only `README.md`. The deployed rocket1000 application may exist in a separate Codex workspace or Vercel-linked source location. **Find and import the authoritative application source first. Do not generate a fake placeholder trading dashboard and call that the existing application.** If you cannot access the application code, stop and report the exact source access needed.

## 1. Inspect the app before choosing an Android wrapper

- Identify the actual frontend framework, repository, build command, authentication/session model, API base URL, Vercel dependencies, browser-only assumptions and backend endpoints.
- Determine whether the frontend builds to self-contained static assets or needs server-side rendering.
- Select the smallest correct Android packaging architecture, recording why:
  - **Static React/Vite/SPA:** Prefer Capacitor 8 (or the version compatible with current dependencies) with a bundled frontend that calls the existing HTTPS API. Add and commit the Android native project.
  - **Hosted SSR/Next.js with essential server routes:** Don't force an invalid static export. Consider a verified HTTPS PWA packaged as a Trusted Web Activity (Bubblewrap), with a valid manifest and Digital Asset Links; or extract a self-contained mobile client with APIs, if needed for native features.
  - **Existing React Native/Expo/native Android app:** Use its native Android build tooling, not a redundant Capacitor wrapper.
- Do not use `localhost`, a laptop hotspot IP such as `172.20.10.3`, or a development-only Capacitor `server.url` as the release backend.

## 2. Android product behavior

- Name: **rocket1000**. Set a stable and unique Android application ID, e.g. `com.rocket1000.mobile` if no ID already exists.
- Generate a launcher icon and splash screen from existing brand assets if available. Preserve the actual app's styling, navigation, dashboard, charts and settings. Optimize tap targets, insets/safe areas, viewport and device back navigation.
- Display live account balance, open positions, order activity, AI analysis, EA connection state and server connection state *only when real data is available*. Don't fabricate account values or signals.
- Show account type (**Demo** or **Live**) based on the authenticated EA/backend account snapshot; do not force the user to choose an account type in settings.
- Make account/settings simple: account details (read-only), EA connection, AI status, API connection, risk controls, logout.
- Offline/connection-loss UI must clearly indicate that current price and position data may be stale. Implement authentication expiry, retry/backoff and secure session handling.

## 3. Security and trading boundaries

- The Android phone runs the client UI only; the MetaTrader 5 terminal and `rocket1000_EA.mq5` keep running on an authorized Windows PC or VPS.
- All phone-to-backend requests use **HTTPS/WSS** with valid certificates. Require authenticated and authorized backend endpoints. Never package MT5 credentials, EA tokens, OpenAI API keys, backend secrets, keystore passwords or admin credentials in the APK.
- AI analysis calls must go via the backend. Ensure any trade request is validated server-side AND by the EA for authentication, account scope, limits, risk controls and emergency stop. Never trust client-side checks alone.
- This packaging task does not authorize sending trades, enabling live execution, changing security/account settings or deploying changes to production. Do not switch on trading just because an APK has been installed.
- Preserve both demo and live account compatibility. Distinguish which account is actually connected; fail closed when uncertain. Do not remove emergency-stop, exposure, daily loss or position-size protections.

## 4. Build the Android project and APK

- Use supported stable Android tooling and versions compatible with the inspected stack; pin major versions and document them.
- Include an Android project, deterministic build scripts and a README with build/prerequisite commands.
- Make a **debug APK** for internal Android installation. If secrets/signing material are not provisioned, do not pretend a release APK is signed. Document a later **signed release APK** workflow without checking keys into Git.
- Prefer a GitHub Actions workflow building on `ubuntu-latest`: install necessary Node/JDK/Android SDK, install dependencies with lockfile, run app checks, build/sync Android assets, run Gradle `assembleDebug`, and upload the APK as a downloadable workflow artifact. Configure path based on actual project layout.
- If a CI/build environment cannot build the APK, state that explicitly and provide the build failure plus recovery steps.

## 5. Acceptance tests and deliverables

- Verify actual app frontend builds and Android Gradle build passes.
- Verify APK file exists and report its exact path, package ID, version, minimum Android version, signing type and build SHA.
- Install and launch on a physical Android phone or emulator when hardware is available. Verify authentication, screen layout, chart render, API access over HTTPS, EA status, Demo/Live badge, reconnection, and emergency stop UI.
- Confirm app opening, login and reconnection **never** issue a trade on their own.
- Check that production build bundles contain no OpenAI keys, EA tokens, passwords or other secrets.
- Deliver: code changes, Android package, download location of actual APK (or GitHub Actions artifact), exact installation instructions, and a short list of unverified items.
- If the source app is missing, deliver a concise blocker report specifying where Codex expects the source to be connected instead of claiming the APK was completed.

## How the owner will install a finished APK

Download the trusted build artifact to the Android phone, open the APK in My Files / Downloads, allow installation from that source if requested, install and launch. Turn the install-source permission off again if no longer required. Do not distribute the debug APK as a production build.

## Official documentation

- Capacitor: https://capacitorjs.com/docs/getting-started
- Android APK generation: https://developer.android.com/build/build-for-release
- Android signing: https://developer.android.com/studio/publish/app-signing
- Trusted Web Activities: https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities
