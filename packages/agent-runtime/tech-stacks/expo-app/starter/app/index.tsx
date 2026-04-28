import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useState } from 'react'

export default function Home() {
  const [count, setCount] = useState(0)
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Shogo Expo Starter</Text>
      <Text style={styles.subtitle}>Tap the counter to verify hot reload.</Text>
      <Pressable style={styles.button} onPress={() => setCount((c) => c + 1)}>
        <Text style={styles.buttonText}>Count: {count}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { color: '#f5f5f7', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#a1a1aa', fontSize: 14, textAlign: 'center' },
  button: {
    marginTop: 16,
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
