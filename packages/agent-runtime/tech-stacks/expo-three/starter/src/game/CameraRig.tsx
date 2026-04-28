import { useFrame, useThree } from '@react-three/fiber/native'
import { Vector3 } from 'three'

const target = new Vector3(0, 0, 0)
const offset = new Vector3(0, 8, 8)

export function CameraRig() {
  const { camera } = useThree()
  useFrame(() => {
    camera.position.lerp(target.clone().add(offset), 0.08)
    camera.lookAt(target)
  })
  return null
}
