import { useEffect, useRef, useState } from 'react'
import { Text, View, StyleSheet } from 'react-native'

export function FpsMeter() {
  const [fps, setFps] = useState(0)
  const frames = useRef(0)
  const last = useRef(performance.now())

  useEffect(() => {
    let raf = 0
    const tick = () => {
      frames.current += 1
      const now = performance.now()
      if (now - last.current >= 1000) {
        setFps(Math.round((frames.current * 1000) / (now - last.current)))
        frames.current = 0
        last.current = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <View style={styles.box} pointerEvents="none">
      <Text style={styles.text}>{fps} fps</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  text: { color: '#fde047', fontFamily: 'System', fontSize: 12 },
})
