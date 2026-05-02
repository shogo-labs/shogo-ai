import { View, Text, StyleSheet } from 'react-native'
import { useGame } from '@/lib/store'

export function HUD() {
  const { playerHp: hp } = useGame()
  return (
    <View style={styles.root} pointerEvents="none">
      <Text style={styles.label}>HP</Text>
      <View style={styles.bar}>
        <View style={[styles.fill, { width: `${hp}%` }]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 12, left: 12, gap: 4 },
  label: { color: '#a1a1aa', fontSize: 10, letterSpacing: 1 },
  bar: { width: 160, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)' },
  fill: { height: '100%', backgroundColor: '#22c55e', borderRadius: 4 },
})
