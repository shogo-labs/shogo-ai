# Stack: Expo (React Native)

This project is an Expo + React Native app with TypeScript.

## Runtime

- **Bundler:** Metro, supervised by the runtime's PreviewManager. **Never run
  `expo start` or `npx expo start` from `exec`** — it has a 5-minute timeout
  and Metro is long-lived. The bundler is started for you.
- **Web preview:** Metro builds a web bundle via `react-native-web`. Most
  layout / state code renders correctly in the browser, but native modules
  (camera, sensors, push) are stubbed.
- **Device preview:** the runtime exposes a tunneled Metro URL plus an
  `exp://…` link the user opens in Expo Go.

## Files

- `App.tsx` — root component.
- `src/` — your code.
- `app.json` — Expo config. Don't change `name` / `slug` casually.
- `babel.config.js` — Expo's Babel preset; required for fast refresh.
- `metro.config.js` — Metro resolver tweaks (e.g. RNW aliasing).

## Conventions

- Use functional components and hooks.
- Use `react-native` primitives (`View`, `Text`, `Pressable`) — not raw
  `div` / `span`.
- For navigation, prefer `expo-router` if added.
- Persistent state: `expo-sqlite` or `@react-native-async-storage/async-storage`.

## Forbidden commands

- `expo start`, `npx expo start`, `npx react-native start`, `metro` — the
  bundler is owned by PreviewManager.
- `kill`, `pkill` on the bundler process.
- `npm install -g expo-cli` — Expo CLI lives in the project's `node_modules`.

If preview seems stuck, request a rebuild via the runtime's preview/rebuild
endpoint instead of restarting Metro yourself.
