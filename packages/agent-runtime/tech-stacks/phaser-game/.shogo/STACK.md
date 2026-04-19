# Tech Stack — Phaser 2D Game

## Project Structure

Your workspace is a **Vite + Phaser 3 + TypeScript** game project. Write code directly into `src/` — Vite rebuilds automatically and the preview panel reloads.

```
src/
  main.ts              ← Entry point: Phaser game config + launch
  scenes/
    Boot.ts            ← Preload assets
    MainScene.ts       ← Primary gameplay scene
    UI.ts              ← HUD / overlay scene
  objects/
    Player.ts          ← Player sprite with physics + input
    Enemy.ts           ← Enemy sprite with AI behavior
  utils/
    constants.ts       ← Game dimensions, physics settings
public/
  assets/              ← Sprites, tilemaps, audio (served statically)
index.html             ← Vite entry HTML
vite.config.ts
package.json           ← Dependencies: phaser
tsconfig.json
```

## How It Works

1. Create scenes under `src/scenes/` and game objects under `src/objects/` using `write_file`
2. Register scenes in `src/main.ts`
3. Vite rebuilds automatically — the preview panel shows the running game

## Available Imports

**Phaser** — `import Phaser from 'phaser'`
```ts
import Phaser from 'phaser'
const { Scene, GameObjects, Physics, Input, Math: PMath, Tilemaps } = Phaser
```

**Installing new packages** — `exec({ command: "bun add <package-name>" })`

## Core Patterns

### Game config (src/main.ts)
```ts
import Phaser from 'phaser'
import { MainScene } from './scenes/MainScene'

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'app',
  backgroundColor: '#1a1a2e',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 300 },
      debug: false,
    },
  },
  scene: [MainScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
}

new Phaser.Game(config)
```

### Scene lifecycle
```ts
export class MainScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys

  constructor() {
    super({ key: 'MainScene' })
  }

  preload() {
    // Load assets: this.load.image('key', 'assets/image.png')
    // For quick prototyping, use generated graphics (see below)
  }

  create() {
    // Set up game objects, physics, collisions, input
    this.cursors = this.input.keyboard!.createCursorKeys()

    // Generated rectangle as placeholder sprite
    const graphics = this.add.graphics()
    graphics.fillStyle(0x00ff00)
    graphics.fillRect(0, 0, 32, 48)
    graphics.generateTexture('player', 32, 48)
    graphics.destroy()

    this.player = this.physics.add.sprite(400, 300, 'player')
    this.player.setCollideWorldBounds(true)
  }

  update(time: number, delta: number) {
    const speed = 200
    this.player.setVelocityX(0)

    if (this.cursors.left.isDown) this.player.setVelocityX(-speed)
    else if (this.cursors.right.isDown) this.player.setVelocityX(speed)

    if (this.cursors.up.isDown && this.player.body!.touching.down) {
      this.player.setVelocityY(-330)
    }
  }
}
```

### Generated textures (no asset files needed)
```ts
const gfx = this.add.graphics()
gfx.fillStyle(0xff6600)
gfx.fillCircle(16, 16, 16)
gfx.generateTexture('ball', 32, 32)
gfx.destroy()
```

### Tilemap from array
```ts
const level = [
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
]
const map = this.make.tilemap({ data: level, tileWidth: 32, tileHeight: 32 })
const tileset = map.addTilesetImage('tiles')!
const layer = map.createLayer(0, tileset, 0, 0)!
layer.setCollisionByExclusion([-1, 0])
this.physics.add.collider(this.player, layer)
```

### Physics groups and collisions
```ts
const enemies = this.physics.add.group()
for (let i = 0; i < 5; i++) {
  const enemy = enemies.create(
    Phaser.Math.Between(100, 700),
    Phaser.Math.Between(100, 500),
    'enemy'
  )
  enemy.setBounce(1)
  enemy.setCollideWorldBounds(true)
  enemy.setVelocity(Phaser.Math.Between(-100, 100), Phaser.Math.Between(-100, 100))
}

this.physics.add.collider(enemies, enemies)
this.physics.add.overlap(this.player, enemies, (player, enemy) => {
  // Handle collision
}, undefined, this)
```

### Scene transitions
```ts
this.scene.start('GameOver', { score: this.score })
this.scene.launch('UI')     // Run UI scene in parallel
this.scene.pause('MainScene')
```

### Text and HUD
```ts
const scoreText = this.add.text(16, 16, 'Score: 0', {
  fontSize: '24px',
  color: '#ffffff',
  fontFamily: 'monospace',
})
scoreText.setScrollFactor(0) // Fixed to camera
```

## Important Rules

- `src/main.ts` creates the `Phaser.Game` — it registers scenes and configures physics
- Each scene is a class extending `Phaser.Scene` in its own file under `src/scenes/`
- Game objects (Player, Enemy, etc.) go in `src/objects/`
- Use **Arcade Physics** for most 2D games — it handles gravity, velocity, collisions
- Use **generated textures** for rapid prototyping — you can swap in real sprites later
- Assets go in `public/assets/` and are loaded in `preload()` with `this.load.image()`
- Always set `parent: 'app'` in the game config to mount into the page
- Use `Phaser.Scale.FIT` + `CENTER_BOTH` for responsive scaling

## Validation

After writing or editing `.ts` files, run `read_lints` with no arguments to check for TypeScript errors and fix immediately. It auto-scopes to the files you just touched.
