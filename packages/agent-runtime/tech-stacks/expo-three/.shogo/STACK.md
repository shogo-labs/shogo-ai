# Stack: Expo + Three.js (3D mobile games)

This project builds 3D mobile games on Expo + React Native using
`@react-three/fiber/native` and `expo-gl`.

## Runtime

- **Bundler:** Metro, supervised by the runtime's PreviewManager. Do **not**
  run `expo start` / `npx expo start` / `metro` via `exec` — the bundler is
  long-lived and `exec` will time out at 5 minutes.
- **Web preview:** Metro builds a `react-native-web` bundle. The starter
  aliases `@react-three/fiber/native` → `@react-three/fiber` so the scene
  renders in a browser canvas; native-only code paths (haptics, gyro) are
  guarded.
- **Device preview:** real-device testing via Expo Go using the tunneled
  Metro URL surfaced in the Studio UI.

## Performance budget — read first

RN + Three.js typically hits **30 FPS** on mid-tier phones, ~half what a
Unity build of the same scene would achieve. To stay above that floor:

1. Cap the scene to one map and ≤ 5 hero archetypes for an MVP.
2. Use **instanced meshes** (`InstancedMesh`) for mobs and projectiles —
   never one mesh per entity.
3. Run a Week-1 perf spike with the `FpsMeter` overlay; budget ~6 ms /
   frame for game logic and ~10 ms for render.
4. Avoid per-frame allocations in the game loop. Pool vectors and matrices.
5. Disable shadows by default; opt-in per material.

## Files

- `App.tsx` — root component, mounts the canvas and HUD.
- `src/lib/store.tsx` — React Context store. Per-frame inputs (move/aim) live
  in `useRef` so `useFrame` can read them without re-rendering; `playerHp` is
  the only field in React state because the HUD subscribes to it.
- `src/game/` — scene primitives (`CameraRig`, `Ground`, `Player`,
  `Mobs`, `Projectiles`, `FpsMeter`).
- `src/ui/` — UI overlay (`Joystick`, `HUD`).
- `metro.config.js` — RNW resolver + asset extensions for `.glb` / `.gltf`.

## Conventions

- Use `useFrame` for per-frame logic and avoid React state inside it.
- Prefer typed arrays + `Matrix4.compose` for instanced transforms.
- `expo-gl` requires the canvas to mount inside a native `<View>`.

## Forbidden commands

- `expo start`, `npx expo start`, `npx react-native start`, `metro`.
- `kill`, `pkill` on the bundler.
- Installing global RN/Expo CLIs.

## Shipping to the App Store / Google Play

This project can be published as a real iOS and Android app with
`publish({ target: "ios" | "android" | "native" })`. Follow the `next_action` in
every response — it is the whole procedure, in order:

`confirm_bundle_id` → `publish_web` → `connect_play` / `connect_asc` →
`play_first_upload` / `asc_app_record` → `needs_icon` → `building` → `testing` →
`submitted` → `live`.

- **A backend has to be published first.** This stack calls its own API, and a
  device has no origin. The release injects the published URL as
  `EXPO_PUBLIC_API_URL`; read that variable for every request base in the app —
  never hardcode `http://localhost` or a relative URL that only works in the
  preview.
- **Keep `.maestro/` current.** The test build runs these flows before any store
  build, and a flow that no longer matches the app blocks every release. A failed
  flow costs nothing, which is the point.
- **An icon is required.** Pass `icon: "<path to a square PNG>"` and the four
  store images are generated from it (1024 icon, adaptive foreground, splash, 512
  Play icon), listed under `.shogo/store-assets/`.
- **Never run `eas-cli` or a browser** for any of this, and never wait on a build
  in the background: the release returns a `release_id`, and you check it when the
  user asks.
