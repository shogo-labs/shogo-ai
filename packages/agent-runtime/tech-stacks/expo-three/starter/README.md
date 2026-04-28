# Expo + Three.js Starter

A 3D mobile game scaffold built on Expo + `@react-three/fiber/native`.

## What's included

- Twin-stick controller (`src/ui/Joystick.tsx`).
- Instanced mobs and projectiles (`src/game/Mobs.tsx`, `Projectiles.tsx`).
- Lerp-follow camera rig (`src/game/CameraRig.tsx`).
- HUD + on-screen FPS overlay.
- `zustand` store for input + entity state.

## Performance reminder

RN + Three.js is roughly half the FPS of an equivalent Unity build on the
same phone. The starter targets 30 FPS on mid-tier devices. Don't add
shadows, real-time GI, or per-entity meshes without re-running a perf spike.

## Running

The Metro bundler is started by Shogo's runtime. Open the device-preview
URL surfaced in the Studio UI in Expo Go, or use the iframe web preview to
quickly verify scene wiring.
