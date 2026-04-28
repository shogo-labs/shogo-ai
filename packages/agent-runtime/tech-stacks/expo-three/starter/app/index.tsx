import { View, StyleSheet } from 'react-native'
import { Canvas } from '@react-three/fiber/native'
import { CameraRig } from '@/game/CameraRig'
import { Ground } from '@/game/Ground'
import { Player } from '@/game/Player'
import { Mobs } from '@/game/Mobs'
import { Projectiles } from '@/game/Projectiles'
import { FpsMeter } from '@/game/FpsMeter'
import { Joystick } from '@/ui/Joystick'
import { HUD } from '@/ui/HUD'

export default function Game() {
  return (
    <View style={styles.root}>
      <Canvas
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, 8, 8], fov: 55 }}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 10, 5]} intensity={0.9} />
        <CameraRig />
        <Ground />
        <Player />
        <Mobs count={32} />
        <Projectiles capacity={128} />
      </Canvas>
      <HUD />
      <Joystick />
      <FpsMeter />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#05060b' },
})
