import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber/native'
import { InstancedMesh, Matrix4, Object3D } from 'three'

export function Mobs({ count }: { count: number }) {
  const ref = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const positions = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: Math.cos((i / count) * Math.PI * 2) * 10,
        z: Math.sin((i / count) * Math.PI * 2) * 10,
        phase: Math.random() * Math.PI * 2,
      })),
    [count],
  )

  useFrame((state) => {
    const m = ref.current
    if (!m) return
    const t = state.clock.elapsedTime
    for (let i = 0; i < count; i++) {
      const p = positions[i]
      dummy.position.set(p.x + Math.cos(t + p.phase) * 0.5, 0.5, p.z + Math.sin(t + p.phase) * 0.5)
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix as unknown as Matrix4)
    }
    m.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} castShadow>
      <boxGeometry args={[0.8, 0.8, 0.8]} />
      <meshStandardMaterial color="#ef4444" />
    </instancedMesh>
  )
}
