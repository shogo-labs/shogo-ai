import { useRef } from 'react'
import { useFrame } from '@react-three/fiber/native'
import { Mesh } from 'three'
import { useGame } from '@/lib/store'

const SPEED = 6

export function Player() {
  const ref = useRef<Mesh>(null)
  const { moveInput } = useGame()

  useFrame((_, dt) => {
    const m = moveInput.current
    const mesh = ref.current
    if (!mesh) return
    mesh.position.x += m.x * SPEED * dt
    mesh.position.z += m.y * SPEED * dt
  })

  return (
    <mesh ref={ref} position={[0, 0.5, 0]} castShadow>
      <capsuleGeometry args={[0.4, 0.8, 4, 8]} />
      <meshStandardMaterial color="#6366f1" />
    </mesh>
  )
}
