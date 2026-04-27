# Tech Stack — Three.js Game

## Project Structure

Your workspace is a **Vite + Three.js + TypeScript** game project. Write code directly into `src/` — Vite rebuilds automatically and the preview panel reloads.

```
src/
  main.ts              ← Entry point: renderer, scene, camera, game loop
  game/
    Scene.ts           ← Scene setup, lighting, environment
    Player.ts          ← Player entity with physics body
    Input.ts           ← Keyboard/mouse/touch input handling
    Physics.ts         ← cannon-es physics world setup
    GameLoop.ts        ← Fixed-timestep update + render loop
  assets/              ← Textures, models, sounds (loaded via URL imports)
  utils/
    math.ts            ← Vector helpers, lerp, clamp
index.html             ← Vite entry HTML with canvas element
vite.config.ts         ← Vite config
package.json           ← Dependencies: three, cannon-es, @types/three
tsconfig.json
```

## How It Works

1. Create game modules under `src/game/` using `write_file`
2. Wire them together in `src/main.ts`
3. Vite rebuilds automatically — the preview panel shows the running game

## Available Imports

**Three.js** — `import * as THREE from 'three'`
```ts
import { Scene, PerspectiveCamera, WebGLRenderer, Mesh, BoxGeometry, MeshStandardMaterial } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
```

**cannon-es (physics)** — `import * as CANNON from 'cannon-es'`
```ts
import { World, Body, Box, Sphere, Vec3, Material, ContactMaterial } from 'cannon-es'
```

**Installing new packages** — `exec({ command: "bun add <package-name>" })`

## Game Loop Pattern

Use a **fixed-timestep** game loop for deterministic physics:

```ts
const clock = new THREE.Clock()
const fixedTimeStep = 1 / 60
let accumulator = 0

function animate() {
  requestAnimationFrame(animate)
  const delta = clock.getDelta()
  accumulator += delta

  while (accumulator >= fixedTimeStep) {
    physicsWorld.step(fixedTimeStep)
    updateGameState(fixedTimeStep)
    accumulator -= fixedTimeStep
  }

  syncMeshesToBodies()
  renderer.render(scene, camera)
}
animate()
```

## Three.js Patterns

### Scene setup
```ts
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 50, 200)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.set(0, 5, 10)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
document.getElementById('app')!.appendChild(renderer.domElement)
```

### Lighting
```ts
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
scene.add(ambientLight)

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
directionalLight.position.set(10, 20, 10)
directionalLight.castShadow = true
directionalLight.shadow.mapSize.set(2048, 2048)
scene.add(directionalLight)
```

### Physics body synced to mesh
```ts
const geometry = new THREE.BoxGeometry(1, 1, 1)
const material = new THREE.MeshStandardMaterial({ color: 0xff6600 })
const mesh = new THREE.Mesh(geometry, material)
mesh.castShadow = true
scene.add(mesh)

const body = new CANNON.Body({
  mass: 1,
  shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
  position: new CANNON.Vec3(0, 5, 0),
})
physicsWorld.addBody(body)

function syncMeshesToBodies() {
  mesh.position.copy(body.position as any)
  mesh.quaternion.copy(body.quaternion as any)
}
```

### Input handling
```ts
const keys: Record<string, boolean> = {}
window.addEventListener('keydown', (e) => { keys[e.code] = true })
window.addEventListener('keyup', (e) => { keys[e.code] = false })

function handleInput(dt: number) {
  const speed = 10
  const force = new CANNON.Vec3()
  if (keys['KeyW']) force.z -= speed
  if (keys['KeyS']) force.z += speed
  if (keys['KeyA']) force.x -= speed
  if (keys['KeyD']) force.x += speed
  playerBody.applyForce(force)
}
```

### Responsive canvas
```ts
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})
```

## Important Rules

- `src/main.ts` is the **entry point** — it creates the renderer, scene, camera, and starts the game loop
- Organize game logic into modules under `src/game/` — one file per system (Physics, Player, Input, etc.)
- Use **cannon-es** for physics, not custom collision detection
- Always use `requestAnimationFrame` for the render loop
- Enable shadows on the renderer and relevant lights/meshes
- Handle window resize to keep the canvas responsive
- Use `THREE.Clock` for frame-independent timing
- Dispose of geometries, materials, and textures when removing objects to prevent memory leaks

## Validation

After writing or editing `.ts` files, run `read_lints` with no arguments to check for TypeScript errors and fix immediately. It auto-scopes to the files you just touched.
