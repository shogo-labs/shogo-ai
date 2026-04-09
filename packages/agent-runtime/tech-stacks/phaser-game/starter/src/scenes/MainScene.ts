import Phaser from 'phaser'

export class MainScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private platforms!: Phaser.Physics.Arcade.StaticGroup

  constructor() {
    super({ key: 'MainScene' })
  }

  create() {
    this.cursors = this.input.keyboard!.createCursorKeys()

    const gfx = this.add.graphics()

    gfx.fillStyle(0x4a9e4a)
    gfx.fillRect(0, 0, 800, 32)
    gfx.generateTexture('ground', 800, 32)

    gfx.clear()
    gfx.fillStyle(0x00cc66)
    gfx.fillRect(0, 0, 32, 48)
    gfx.generateTexture('player', 32, 48)

    gfx.destroy()

    this.platforms = this.physics.add.staticGroup()
    this.platforms.create(400, 584, 'ground')
    this.platforms.create(300, 420, 'ground').setScale(0.25, 1).refreshBody()
    this.platforms.create(600, 300, 'ground').setScale(0.25, 1).refreshBody()

    this.player = this.physics.add.sprite(100, 450, 'player')
    this.player.setCollideWorldBounds(true)
    this.player.setBounce(0.1)

    this.physics.add.collider(this.player, this.platforms)

    this.add.text(16, 16, 'Arrow keys to move', {
      fontSize: '18px',
      color: '#ffffff',
      fontFamily: 'monospace',
    })
  }

  update() {
    const speed = 200

    if (this.cursors.left.isDown) {
      this.player.setVelocityX(-speed)
    } else if (this.cursors.right.isDown) {
      this.player.setVelocityX(speed)
    } else {
      this.player.setVelocityX(0)
    }

    if (this.cursors.up.isDown && this.player.body!.touching.down) {
      this.player.setVelocityY(-330)
    }
  }
}
