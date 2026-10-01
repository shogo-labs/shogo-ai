// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import { Platform, View } from "react-native"
import { BUDDY_ASPECT, BuddyEngine, type BuddyEmote, type BuddyState, type LogoStyle } from "./engine"
import { DEFAULT_BUDDY_LOOK, type BuddyLook } from "./look"

export interface ShogoBuddyHandle {
  engine: BuddyEngine
  poke(): void
  emote(emote: BuddyEmote): void
  appear(): void
  hop(): void
  jiggle(strength?: number): void
  fromLogo(): void
  toLogo(): void
}

export interface ShogoBuddyProps {
  /** Body width in CSS pixels; the canvas is taller to fit antenna and particles. */
  size: number
  state: BuddyState
  color: string
  /** Accessories on the gummy block; anything left out uses the default. */
  look?: Partial<BuddyLook>
  /** How the Shogo mark's rays turn into the character and back. */
  logoStyle?: LogoStyle
  mini?: boolean
  /** Follow the pointer anywhere in the window. */
  followPointer?: boolean
  /** Hover reactions and click-to-poke. */
  interactive?: boolean
  reducedMotion?: boolean
  onDizzy?: () => void
}

/** Canvas-drawn Shogo buddy. Web only; renders an empty box elsewhere. */
export const ShogoBuddy = forwardRef<ShogoBuddyHandle, ShogoBuddyProps>(function ShogoBuddy(
  { size, state, color, look, logoStyle = "vortex", mini = false, followPointer = true, interactive = false, reducedMotion = false, onDizzy },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<BuddyEngine | null>(null)
  if (!engineRef.current) engineRef.current = new BuddyEngine()
  const engine = engineRef.current
  const height = Math.round(size * BUDDY_ASPECT)

  useImperativeHandle(
    ref,
    () => ({
      engine,
      poke: () => engine.poke(),
      emote: (emote) => engine.emote(emote),
      appear: () => engine.appear(),
      hop: () => engine.hop(),
      jiggle: (strength = 0.08) => engine.jiggle(strength),
      fromLogo: () => engine.fromLogo(),
      toLogo: () => engine.toLogo(),
    }),
    [engine],
  )

  engine.isMini = mini
  engine.look = { ...DEFAULT_BUDDY_LOOK, ...look }
  engine.logoStyle = logoStyle
  engine.reducedMotion = reducedMotion
  useEffect(() => engine.setBodyColor(color), [engine, color])
  useEffect(() => engine.setState(state), [engine, state])
  useEffect(() => {
    engine.onDizzy = onDizzy ?? null
  }, [engine, onDizzy])
  useEffect(() => () => engine.dispose(), [engine])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || Platform.OS !== "web") return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      engine.update(reducedMotion ? 0 : dt)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, height)
      engine.draw(ctx, size, height)
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      if (raf || document.visibilityState === "hidden") return
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start())
    start()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [engine, size, height, reducedMotion])

  useEffect(() => {
    if (!followPointer || Platform.OS !== "web") return
    const onMove = (event: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const cx = rect.left + rect.width / 2
      const cy = rect.bottom - size * 0.5
      engine.lookX = Math.tanh((event.clientX - cx) / 260)
      engine.lookY = -Math.tanh((event.clientY - cy) / 200)
      if (interactive) {
        const r = size * 0.36
        engine.hover((event.clientX - cx) ** 2 + (event.clientY - cy) ** 2 <= r * r)
      }
    }
    window.addEventListener("mousemove", onMove)
    return () => window.removeEventListener("mousemove", onMove)
  }, [engine, followPointer, interactive, size])

  if (Platform.OS !== "web") return <View style={{ width: size, height }} />
  return (
    <canvas
      ref={canvasRef}
      onClick={interactive ? () => engine.poke() : undefined}
      style={{ width: size, height, display: "block", cursor: interactive ? "pointer" : undefined }}
    />
  )
})
