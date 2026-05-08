import React from 'react'
import { SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native'

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <Text style={styles.title}>Shogo</Text>
        <Text style={styles.subtitle}>React Native (bare) + Hono backend</Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b0f' },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#9aa0a6', fontSize: 14, marginTop: 8, textAlign: 'center' },
})
