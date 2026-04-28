export function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[64, 64]} />
      <meshStandardMaterial color="#1a1d2b" />
    </mesh>
  )
}
