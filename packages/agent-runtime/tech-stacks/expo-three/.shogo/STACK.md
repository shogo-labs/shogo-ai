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
- `src/lib/store.ts` — `zustand` store for entity state.
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
