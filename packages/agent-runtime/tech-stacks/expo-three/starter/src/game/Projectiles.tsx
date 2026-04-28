import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber/native'
import { InstancedMesh, Matrix4, Object3D } from 'three'

export function Projectiles({ capacity }: { capacity: number }) {
  const ref = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const slots = useMemo(
    () =>
      Array.from({ length: capacity }, (_, i) => ({
        active: false,
        x: i * 0.01,
        y: -10,
        z: 0,
      })),
    [capacity],
  )

  useFrame(() => {
    const m = ref.current
    if (!m) return
    for (let i = 0; i < capacity; i++) {
      const s = slots[i]
      dummy.position.set(s.x, s.active ? s.y : -10, s.z)
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix as unknown as Matrix4)
    }
    m.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, capacity]}>
      <sphereGeometry args={[0.1, 6, 6]} />
      <meshBasicMaterial color="#fde047" />
    </instancedMesh>
  )
}
