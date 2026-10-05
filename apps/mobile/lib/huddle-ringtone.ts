// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A soft two-tone ring for incoming huddles, synthesised with Web Audio so
 * there is no asset to ship. Phones vibrate instead.
 */
import { Platform, Vibration } from 'react-native'

const PERIOD_MS = 2_400

export function startRingtone(): () => void {
  if (Platform.OS !== 'web') {
    Vibration.vibrate([0, 400, 300, 400], true)
    return () => Vibration.cancel()
  }
  const Ctx: typeof AudioContext | undefined = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
  if (!Ctx) return () => {}
  let ctx: AudioContext
  try {
    ctx = new Ctx()
  } catch {
    return () => {}
  }

  const chirp = (at: number, freq: number) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.12, at + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.4)
  }
  const ring = () => {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const t = ctx.currentTime + 0.05
    chirp(t, 880)
    chirp(t + 0.4, 660)
  }
  ring()
  const timer = setInterval(ring, PERIOD_MS)
  return () => {
    clearInterval(timer)
    void ctx.close().catch(() => {})
  }
}
