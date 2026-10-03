// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react"
import { Platform } from "react-native"
import {
  BUDDY_ASPECT,
  BUDDY_FINISHES,
  BuddyEngine,
  type BuddyEmote,
  type BuddyFinish,
  type BuddyState,
  type LogoStyle,
} from "./engine"
import { BUDDY_WEBVIEW_HTML } from "./buddy-webview.generated"
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
  /** Accessories, colour and finish; anything left out uses the default. A
   * look colour wins over `color`, which is the fallback (the app accent). */
  look?: Partial<BuddyLook>
  /** Overrides the look's finish with exact strengths (the motion lab). */
  finish?: BuddyFinish
  /** How the Shogo mark's rays turn into the character and back. */
  logoStyle?: LogoStyle
  mini?: boolean
  /** Follow the pointer anywhere in the window. */
  followPointer?: boolean
  /** Hover reactions and click-to-poke. */
  interactive?: boolean
  reducedMotion?: boolean
  /** Draw one frame whenever the props change instead of animating. */
  still?: boolean
  /** Announced for an interactive buddy; a non-interactive one is decorative. */
  accessibilityLabel?: string
  onDizzy?: () => void
}

/** Canvas-drawn on web and desktop; native mobile uses the bundled WebView renderer. */
export const ShogoBuddy = forwardRef<ShogoBuddyHandle, ShogoBuddyProps>(function ShogoBuddy(
  {
    size,
    state,
    color,
    look,
    finish: finishOverride,
    logoStyle = "vortex",
    mini = false,
    followPointer = true,
    interactive = false,
    reducedMotion = false,
    still = false,
    accessibilityLabel = "Shogo",
    onDizzy,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nativeWebViewRef = useRef<any>(null)
  const nativeReadyRef = useRef(false)
  const engineRef = useRef<BuddyEngine | null>(null)
  if (!engineRef.current) engineRef.current = new BuddyEngine()
  const engine = engineRef.current
  const height = Math.round(size * BUDDY_ASPECT)
  const nativeSizeStyle = useMemo(
    () => ({
      width: size,
      height,
      flex: 0,
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: "auto" as const,
      backgroundColor: "transparent",
    }),
    [size, height],
  )

  const topper = look?.topper ?? DEFAULT_BUDDY_LOOK.topper
  const face = look?.face ?? DEFAULT_BUDDY_LOOK.face
  const tail = look?.tail ?? DEFAULT_BUDDY_LOOK.tail
  const eyewear = look?.eyewear ?? DEFAULT_BUDDY_LOOK.eyewear
  const neck = look?.neck ?? DEFAULT_BUDDY_LOOK.neck
  const bolts = look?.bolts ?? DEFAULT_BUDDY_LOOK.bolts
  const blush = look?.blush ?? DEFAULT_BUDDY_LOOK.blush
  const bodyColor = look?.color ?? color
  const finish = finishOverride ?? BUDDY_FINISHES[look?.finish ?? DEFAULT_BUDDY_LOOK.finish]
  const nativePropsJson = useMemo(
    () =>
      JSON.stringify({
        size,
        state,
        color: bodyColor,
        look: { topper, face, tail, eyewear, neck, bolts, blush },
        finish,
        mini,
        reducedMotion,
        still,
      }),
    [size, state, bodyColor, topper, face, tail, eyewear, neck, bolts, blush, finish, mini, reducedMotion, still],
  )
  const injectNative = useCallback((script: string) => {
    nativeWebViewRef.current?.injectJavaScript(`${script};true;`)
  }, [])
  const sendNativeProps = useCallback(() => {
    if (Platform.OS !== "web" && nativeReadyRef.current) {
      injectNative(`window.__shogoBuddySetProps && window.__shogoBuddySetProps(${nativePropsJson})`)
    }
  }, [injectNative, nativePropsJson])
  const sendNativeCommand = useCallback(
    (command: Record<string, unknown>) => {
      if (Platform.OS !== "web" && nativeReadyRef.current) {
        injectNative(`window.__shogoBuddyCommand && window.__shogoBuddyCommand(${JSON.stringify(command)})`)
      }
    },
    [injectNative],
  )
  const onNativeMessage = useCallback(
    (event: { nativeEvent?: { data?: string } }) => {
      try {
        const message = JSON.parse(event.nativeEvent?.data ?? "")
        if (message?.type !== "ready") return
        nativeReadyRef.current = true
        sendNativeProps()
      } catch {
        // Ignore messages that are not JSON bridge messages.
      }
    },
    [sendNativeProps],
  )
  useImperativeHandle(
    ref,
    () => ({
      engine,
      poke: () => (Platform.OS === "web" ? engine.poke() : sendNativeCommand({ type: "poke" })),
      emote: (emote) =>
        Platform.OS === "web" ? engine.emote(emote) : sendNativeCommand({ type: "emote", emote }),
      appear: () => (Platform.OS === "web" ? engine.appear() : sendNativeCommand({ type: "appear" })),
      hop: () => (Platform.OS === "web" ? engine.hop() : sendNativeCommand({ type: "hop" })),
      jiggle: (strength = 0.08) =>
        Platform.OS === "web" ? engine.jiggle(strength) : sendNativeCommand({ type: "jiggle", strength }),
      fromLogo: () => (Platform.OS === "web" ? engine.fromLogo() : sendNativeCommand({ type: "from-logo" })),
      toLogo: () => (Platform.OS === "web" ? engine.toLogo() : sendNativeCommand({ type: "to-logo" })),
    }),
    [engine, sendNativeCommand],
  )
  // Layout effects run before the parent's, so an entrance played from
  // IslandBuddy's layout effect already sees these.
  useLayoutEffect(() => {
    engine.isMini = mini
    engine.logoStyle = logoStyle
    engine.reducedMotion = reducedMotion
    engine.wake()
  }, [engine, mini, logoStyle, reducedMotion])
  useLayoutEffect(() => {
    engine.look = { ...DEFAULT_BUDDY_LOOK, topper, face, tail, eyewear, neck, bolts, blush }
  }, [engine, topper, face, tail, eyewear, neck, bolts, blush])
  useLayoutEffect(() => {
    engine.finish = finish
  }, [engine, finish])
  useEffect(() => {
    sendNativeProps()
  }, [sendNativeProps])
  useEffect(() => engine.setBodyColor(bodyColor), [engine, bodyColor])
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
    let sleep: ReturnType<typeof setTimeout> | undefined
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      engine.update(reducedMotion ? 0 : dt)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, height)
      engine.draw(ctx, size, height)
      if (still || engine.resting) {
        raf = 0
        const wait = still ? null : engine.msUntilWake()
        if (wait != null) sleep = setTimeout(start, wait)
        return
      }
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      if (raf || document.visibilityState === "hidden") return
      clearTimeout(sleep)
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      clearTimeout(sleep)
      raf = 0
    }
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start())
    engine.onWake = start
    start()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      engine.onWake = null
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [engine, size, height, reducedMotion, still])

  useEffect(() => {
    if (!followPointer || still || Platform.OS !== "web") return
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
  }, [engine, followPointer, interactive, still, size])

  if (Platform.OS !== "web") {
    const WebView = require("react-native-webview").default
    return (
      <WebView
        ref={nativeWebViewRef}
        source={{ html: BUDDY_WEBVIEW_HTML }}
        // react-native-webview gives both its container and the view `flex: 1`
        // and `overflow: hidden`. In a parent shorter than the canvas (the 48pt
        // header slot) that squeezes the view to the parent's height and clips
        // the bottom of the character, so pin the size.
        style={nativeSizeStyle}
        containerStyle={nativeSizeStyle}
        originWhitelist={["*"]}
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        onMessage={onNativeMessage}
      />
    )
  }
  return (
    <canvas
      ref={canvasRef}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `${accessibilityLabel}. Press to poke.`,
            onClick: () => engine.poke(),
            onKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              engine.poke()
            },
          }
        : { "aria-hidden": true })}
      style={{ width: size, height, display: "block", cursor: interactive ? "pointer" : undefined }}
    />
  )
})
