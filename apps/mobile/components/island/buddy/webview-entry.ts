// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { BuddyEngine, type BuddyState } from "./engine"
import { DEFAULT_BUDDY_LOOK, normalizeBuddyLook, type BuddyLook } from "./look"

interface BuddyWebViewProps {
  size: number
  state: BuddyState
  color: string
  look: BuddyLook
  mini?: boolean
  reducedMotion?: boolean
  still?: boolean
}

const initialProps: BuddyWebViewProps = {
  size: 48,
  state: "idle",
  color: "#F47B3A",
  look: DEFAULT_BUDDY_LOOK,
  mini: false,
  reducedMotion: false,
  still: false,
}

const canvas = document.getElementById("buddy") as HTMLCanvasElement
const engine = new BuddyEngine()
let props = initialProps
let frameHandle = 0
let sleepHandle: number | undefined
let last = performance.now()

function post(message: unknown) {
  const bridge = (window as Window & { ReactNativeWebView?: { postMessage(value: string): void } }).ReactNativeWebView
  bridge?.postMessage(JSON.stringify(message))
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.max(1, Math.round(props.size * dpr))
  canvas.height = Math.max(1, Math.round(props.size * 1.4 * dpr))
  canvas.style.width = `${props.size}px`
  canvas.style.height = `${Math.round(props.size * 1.4)}px`
}

function start() {
  if (frameHandle || document.visibilityState === "hidden") return
  clearTimeout(sleepHandle)
  last = performance.now()
  frameHandle = requestAnimationFrame(frame)
}

function stop() {
  cancelAnimationFrame(frameHandle)
  clearTimeout(sleepHandle)
  frameHandle = 0
}

function frame(now: number) {
  frameHandle = 0
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  engine.update(props.reducedMotion ? 0 : dt)
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const dpr = canvas.width / props.size
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, props.size, props.size * 1.4)
  engine.draw(ctx, props.size, props.size * 1.4)
  if (props.still || engine.resting) {
    const wait = engine.msUntilWake()
    if (wait != null) sleepHandle = window.setTimeout(start, wait)
    return
  }
  start()
}

function setProps(next: Partial<BuddyWebViewProps>) {
  props = {
    ...props,
    ...next,
    look: normalizeBuddyLook(next.look ?? props.look),
  }
  engine.isMini = props.mini ?? false
  engine.reducedMotion = props.reducedMotion ?? false
  engine.look = props.look
  engine.setBodyColor(props.color)
  engine.setState(props.state)
  resize()
  engine.wake()
  start()
}

function runCommand(command: { type: string; emote?: string; strength?: number }) {
  if (command.type === "poke") engine.poke()
  else if (command.type === "hop") engine.hop()
  else if (command.type === "emote" && command.emote) engine.emote(command.emote as Parameters<typeof engine.emote>[0])
  else if (command.type === "appear") engine.appear()
  else if (command.type === "jiggle") engine.jiggle(command.strength ?? 0.08)
  else if (command.type === "from-logo") engine.fromLogo()
  else if (command.type === "to-logo") engine.toLogo()
}

function handleMessage(event: MessageEvent) {
  const raw = event.data
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw
    if (data && typeof data === "object" && data.type === "props") setProps(data.props)
    else if (data && typeof data === "object") runCommand(data)
  } catch {
    // Ignore malformed messages from the host.
  }
}

const bridgeWindow = window as Window & {
  __shogoBuddySetProps?: typeof setProps
  __shogoBuddyCommand?: typeof runCommand
}
bridgeWindow.__shogoBuddySetProps = setProps
bridgeWindow.__shogoBuddyCommand = runCommand

window.addEventListener("message", handleMessage)
document.addEventListener("message", handleMessage as EventListener)
document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? stop() : start()))
window.addEventListener("resize", resize)
canvas.addEventListener("click", () => engine.poke())
canvas.addEventListener("touchend", () => engine.poke(), { passive: true })
engine.onWake = start
resize()
setProps(initialProps)
post({ type: "ready" })
