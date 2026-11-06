---
name: native-release
version: 1.0.0
description: Ship this Expo project to the App Store and Google Play from Shogo — the exact order of steps, what each next_action means, and what to tell the user
trigger: "app store|google play|play store|ship to ios|ship to android|publish app|native release|testflight|play console|app store connect|bundle id|bundle identifier|android package|maestro flows|ota update|app icon|store listing"
tools: [publish, exec, write_file, read_file]
---

# Shipping to the App Store and Google Play

`publish({ target: "ios" | "android" | "native" })` ships this project. One call
does the whole thing: a test build runs the project's Maestro flows first, and the
store build only starts if they pass — so a broken flow costs nothing.

Every response carries `next_action` and a `user_message`. **Follow `next_action`.
Do not guess at the flow, and do not run `eas-cli`, `expo build`, or any browser
automation** — Shogo's API makes every build call itself.

## The order (this is the whole procedure)

1. **Bundle id** — `confirm_bundle_id`. Show both ids (`ios.bundleIdentifier`,
   `android.package`) and get them confirmed. They lock after the first store
   upload; changing one after that means a new app listing.
2. **Backend** — `publish_web`. If this project has `server.tsx`,
   `custom-routes.ts` or a Prisma schema, the app calls its own API and a device
   has no origin to call it on. Publish the web version first: the release then
   injects its URL as `EXPO_PUBLIC_API_URL`. An app that ships without this
   installs and shows nothing.
3. **Store connections** — `connect_play` / `connect_asc`.
   - Play: the user invites the **publisher email the response returns** in Play
     Console → Users and permissions, granting "Release apps to testing tracks"
     (and production when ready). They never handle a JSON key; Shogo's own
     publisher account does the submit.
   - App Store Connect: Apple cannot delegate publishing, so the user adds their
     own ASC API key in Project → App stores. The key needs App Manager access.
4. **The two hand steps that have no API** — say this plainly, once, and do not
   pretend a retry will fix them:
   - `play_first_upload`: Play has never seen this package. Download the build
     from the link in the response and upload it once in Play Console. Google
     creates the app record; every later release is automatic.
   - `asc_app_record`: create the app in App Store Connect (Apps → + → New App)
     with the exact bundle id shown.
5. **Icon** — `needs_icon`. Ask for a logo (any square PNG) and pass
   `icon: "<path>"`. Shogo generates the 1024 iOS icon, the Android adaptive icon
   (inset so circle masks keep it whole), the splash icon and the 512 Play icon,
   and lists them under `.shogo/store-assets/` so the user can commit them.
6. **Release** — then `building` → `testing` → `submitted` → `live`, or
   `test_failed` with the failing flow and step.

## Polling

The release is asynchronous and `publish` returns immediately with a
`release_id`. **Never** start a background process, a `sleep` loop, or a watcher
for a build. When the user asks how it is going, call
`publish({ release_id })` and report what it says. `testing` means the emulator /
simulator build and Maestro are running; `submitted` means the store has it;
`live` is the only thing you may call "shipped".

## What it costs

Paid plans only — `plan_not_allowed` means the workspace needs an upgrade (point
at Settings → Billing), not that the project is wrong. Billing is usage credits
at 1.2× the underlying price: a build is priced by the class it runs on, a
Maestro run is $0.05 plus CI minutes, and Updates MAU is billed monthly. A failed
test never charges a store build. If a build runs on a class with no published
price it is deliberately **not** charged — say "unpriced, we are checking with the
provider" rather than quoting a number.

## Things to get right

- **Bundle id / package lock**: after the first store upload they are fixed.
  Confirm them *before* the first release, not after a failure.
- **Android keystore**: export it from Project → App stores and keep it. Losing it
  locks the user out of their own Play listing; uploading an existing keystore is
  how an app moves in from elsewhere.
- **Maestro flows**: keep `.maestro/*.yaml` current — they are what the test stage
  runs, and a flow that no longer matches the app blocks every release. With no
  flows the stage is skipped and the response says so.
- **OTA updates** are not available yet; an unchanged project still gets a store
  build. Never tell the user an update was pushed over the air.
- **Never** run `eas-cli`, `expo submit`, or a browser for any of this. If a step
  needs a human, that is what `next_action` is for.
