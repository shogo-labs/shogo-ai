import { useRef } from 'react'
import { PanResponder, View, StyleSheet, Animated } from 'react-native'
import { useGame } from '@/lib/store'

const RADIUS = 60

export function Joystick() {
  const knob = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => {
        const dx = Math.max(-RADIUS, Math.min(RADIUS, g.dx))
        const dy = Math.max(-RADIUS, Math.min(RADIUS, g.dy))
        knob.setValue({ x: dx, y: dy })
        useGame.getState().setMove({ x: dx / RADIUS, y: dy / RADIUS })
      },
      onPanResponderRelease: () => {
        Animated.spring(knob, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start()
        useGame.getState().setMove({ x: 0, y: 0 })
      },
    }),
  ).current

  return (
    <View style={styles.base} {...responder.panHandlers}>
      <Animated.View style={[styles.knob, { transform: knob.getTranslateTransform() }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  base: {
    position: 'absolute',
    bottom: 32,
    left: 32,
    width: RADIUS * 2,
    height: RADIUS * 2,
    borderRadius: RADIUS,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  knob: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#6366f1',
  },
})
