// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Island motion lab: the island shape and the Shogo buddy on a fake desktop,
 * with every mode, state and emote on a button. Compares the spring motion
 * against the current tween motion, with a slow-motion switch.
 *
 * Usage: `bun run dev:web` in apps/mobile, then open `/dev/island-demo`.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Platform, Pressable, ScrollView, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { cn } from "@shogo/shared-ui/primitives"
import { useIslandAccent } from "@/components/island/island-accent"
import { ShogoBuddy, type ShogoBuddyHandle } from "@/components/island/buddy/ShogoBuddy"
import {
  BUDDY_ASPECT,
  BUDDY_EMOTE_NAMES,
  BUDDY_PALETTE,
  BUDDY_STATE_NAMES,
  LOGO_STYLES,
  LOGO_STYLE_NAMES,
  type BuddyEmote,
  type BuddyState,
  type LogoStyle,
} from "@/components/island/buddy/engine"
import { BuddyCustomizer } from "@/components/island/buddy/BuddyCustomizer"
import { DEFAULT_BUDDY_LOOK, type BuddyLook } from "@/components/island/buddy/look"
import { Tracked } from "@/components/island/motion/spring"

declare const __DEV__: boolean

type Mode = "hidden" | "collapsed" | "expanded"
type CardView = "inbox" | "chat"
type MotionStyle = "spring" | "tween"

const STAGE_W = 900
const STAGE_H = 460
const NOTCH_W = 200
const MENU_H = 32
const NOTCH_LEFT = (STAGE_W - NOTCH_W) / 2
const BUDDY_CANVAS = 72
const BUDDY_BODY = BUDDY_CANVAS * 0.66

interface Shape {
  left: number
  right: number
  height: number
  radius: number
}

function shapeFor(mode: Mode, view: CardView, hovered: boolean): Shape {
  switch (mode) {
    case "hidden":
      return { left: hovered ? 36 : 22, right: hovered ? 36 : 22, height: MENU_H, radius: 12 }
    case "collapsed":
      return { left: 40, right: 170, height: MENU_H, radius: 14 }
    case "expanded":
      return { left: 150, right: 150, height: view === "inbox" ? 216 : 330, radius: 22 }
  }
}

function buddyFor(
  mode: Mode,
  shape: Shape,
  logoUnfold: boolean,
): { cx: number; cy: number; d: number; opacity: number } {
  switch (mode) {
    case "hidden":
      // With the unfold on, the buddy rests as the Shogo mark in the idle wing.
      return logoUnfold
        ? { cx: NOTCH_LEFT - shape.left / 2, cy: MENU_H / 2, d: 15, opacity: 1 }
        : { cx: NOTCH_LEFT - shape.left / 2, cy: MENU_H / 2, d: 6, opacity: 0 }
    case "collapsed":
      return { cx: NOTCH_LEFT - 20, cy: MENU_H / 2 + 1, d: 19, opacity: 1 }
    case "expanded":
      return { cx: NOTCH_LEFT - shape.left + 58, cy: MENU_H + 62, d: 60, opacity: 1 }
  }
}

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4
const easeInCubic = (t: number) => t ** 3

/** One animated number that can run either as the new spring or the current tween. */
class Channel {
  private tracked: Tracked
  private tween: { from: number; to: number; start: number; duration: number; ease: (t: number) => number } | null =
    null
  private current: number

  constructor(
    value: number,
    private alwaysSpring = false,
  ) {
    this.tracked = new Tracked(value)
    this.current = value
  }

  get value() {
    return this.current
  }

  to(target: number, style: MotionStyle, nowMs: number) {
    if (style === "spring") {
      if (this.tween) this.tracked.jump(this.current)
      this.tween = null
      if (this.alwaysSpring) this.tracked.springTo(target)
      else this.tracked.animateTo(target, nowMs)
      return
    }
    const growing = target >= this.current
    this.tween = {
      from: this.current,
      to: target,
      start: nowMs,
      duration: growing ? 360 : 190,
      ease: growing ? easeOutQuart : easeInCubic,
    }
  }

  step(dt: number, nowMs: number) {
    if (this.tween) {
      const p = Math.min(1, (nowMs - this.tween.start) / this.tween.duration)
      this.current = this.tween.from + (this.tween.to - this.tween.from) * this.tween.ease(p)
      if (p >= 1) this.tween = null
    } else {
      this.tracked.step(dt, nowMs)
      this.current = this.tracked.value
    }
  }
}

const SESSIONS: { title: string; project: string; state: BuddyState; color: string }[] = [
  { title: "Fix auth redirect loop", project: "Web app", state: "working", color: BUDDY_PALETTE.burnt },
  { title: "Add Stripe webhooks", project: "Billing", state: "approval", color: BUDDY_PALETTE.orange },
  { title: "Write onboarding copy", project: "Marketing", state: "finished", color: BUDDY_PALETTE.apricot },
]

const KEYFRAMES = `
@keyframes islandContentIn {
  from { opacity: 0; filter: blur(8px); transform: scale(0.97) translateY(-4px); }
  to { opacity: 1; filter: blur(0); transform: none; }
}
`

function contentIn(delayMs: number, slow: number): CSSProperties {
  return { animation: `islandContentIn ${300 / slow}ms cubic-bezier(.2,.8,.2,1) ${delayMs / slow}ms both` }
}

function Island({
  mode,
  view,
  motion,
  speed,
  buddyState,
  look,
  logoUnfold,
  logoStyle,
  accent,
  buddyRef,
  onHoverChange,
  hovered,
  onPress,
}: {
  mode: Mode
  view: CardView
  motion: MotionStyle
  speed: number
  buddyState: BuddyState
  look: BuddyLook
  logoUnfold: boolean
  logoStyle: LogoStyle
  accent: string
  buddyRef: React.RefObject<ShogoBuddyHandle | null>
  onHoverChange: (hovered: boolean) => void
  hovered: boolean
  onPress: () => void
}) {
  const shapeEl = useRef<HTMLDivElement | null>(null)
  const buddyEl = useRef<HTMLDivElement | null>(null)
  const channels = useRef<Record<string, Channel> | null>(null)
  if (!channels.current) {
    const s = shapeFor("hidden", "inbox", false)
    const b = buddyFor("hidden", s, logoUnfold)
    channels.current = {
      left: new Channel(s.left),
      right: new Channel(s.right),
      height: new Channel(s.height),
      radius: new Channel(s.radius),
      cx: new Channel(b.cx, true),
      cy: new Channel(b.cy, true),
      d: new Channel(b.d, true),
      opacity: new Channel(b.opacity),
    }
  }
  const clock = useRef(0)
  const speedRef = useRef(speed)
  speedRef.current = speed
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const c = channels.current!
    const shape = shapeFor(mode, view, hovered)
    const buddy = buddyFor(mode, shape, logoUnfold)
    const now = clock.current
    c.left.to(shape.left, motion, now)
    c.right.to(shape.right, motion, now)
    c.height.to(shape.height, motion, now)
    c.radius.to(shape.radius, motion, now)
    c.cx.to(buddy.cx, motion, now)
    c.cy.to(buddy.cy, motion, now)
    c.d.to(buddy.d, motion, now)
    c.opacity.to(buddy.opacity, motion, now)
  }, [mode, view, hovered, motion, logoUnfold])

  const prevMode = useRef<Mode>(mode)
  useEffect(() => {
    const prev = prevMode.current
    prevMode.current = mode
    const engine = buddyRef.current?.engine
    if (!engine || !logoUnfold) return
    if (prev === "hidden" && mode !== "hidden") engine.fromLogo()
    else if (prev !== "hidden" && mode === "hidden") engine.toLogo()
  }, [mode, logoUnfold, buddyRef])

  useEffect(() => {
    if (modeRef.current === "hidden") buddyRef.current?.engine.showLogo(logoUnfold)
  }, [logoUnfold, buddyRef])

  useEffect(() => {
    if (hovered && mode === "hidden" && logoUnfold) buddyRef.current?.engine.logoPeek()
  }, [hovered, mode, logoUnfold, buddyRef])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000) * speedRef.current
      last = t
      clock.current += dt * 1000
      const c = channels.current!
      for (const ch of Object.values(c)) ch.step(dt, clock.current)
      const left = NOTCH_LEFT - c.left.value
      const width = c.left.value + NOTCH_W + c.right.value
      const el = shapeEl.current
      if (el) {
        el.style.left = `${left}px`
        el.style.width = `${width}px`
        el.style.height = `${Math.max(0, c.height.value)}px`
        const r = Math.max(0, c.radius.value)
        el.style.borderRadius = `0 0 ${r}px ${r}px`
      }
      const b = buddyEl.current
      if (b) {
        const scale = Math.max(0, c.d.value) / BUDDY_BODY
        const originY = BUDDY_CANVAS * BUDDY_ASPECT - BUDDY_CANVAS * 0.5
        b.style.transformOrigin = `${BUDDY_CANVAS / 2}px ${originY}px`
        b.style.transform = `translate(${c.cx.value - left - BUDDY_CANVAS / 2}px, ${c.cy.value - originY}px) scale(${scale})`
        b.style.opacity = String(Math.max(0, Math.min(1, c.opacity.value)))
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const expanded = mode === "expanded"
  return (
    <div
      ref={shapeEl}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onClick={mode === "expanded" ? undefined : onPress}
      style={{
        position: "absolute",
        top: 0,
        background: "#000",
        overflow: "hidden",
        cursor: mode === "expanded" ? "default" : "pointer",
        boxShadow: expanded ? "0 18px 50px rgba(0,0,0,0.45)" : "none",
        transition: "box-shadow 300ms",
      }}
    >
      {mode === "collapsed" ? (
        <div
          key="collapsed"
          style={{
            position: "absolute",
            left: 40 + NOTCH_W + 10,
            right: 10,
            top: 0,
            height: MENU_H,
            display: "flex",
            alignItems: "center",
            gap: 8,
            ...contentIn(140, speed),
          }}
        >
          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>Web app</span>
          <span style={{ color: "#a1a1aa", fontSize: 11, flex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            Editing auth.ts
          </span>
          <div style={{ display: "flex", marginRight: -4 }}>
            {SESSIONS.slice(1).map((s, i) => (
              <div key={s.title} style={{ marginLeft: -6, ...contentIn(200 + i * 35, speed) }}>
                <ShogoBuddy size={20} state={s.state} color={s.color} look={look} mini followPointer={false} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {expanded ? (
        <div key={`card-${view}`} style={{ position: "absolute", inset: 0, top: 0 }}>
          <div
            style={{
              height: MENU_H,
              display: "flex",
              alignItems: "center",
              padding: "0 14px",
              justifyContent: "space-between",
              ...contentIn(300, speed),
            }}
          >
            <span style={{ color: "#fafafa", fontSize: 12, fontWeight: 600 }}>{view === "inbox" ? "Shogo" : "Fix auth redirect loop"}</span>
            <span style={{ color: "#71717a", fontSize: 11 }}>3 running</span>
          </div>
          <div style={{ position: "absolute", left: 110, right: 12, top: MENU_H + 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {(view === "inbox" ? SESSIONS : SESSIONS.slice(0, 1)).map((s, i) => (
              <div
                key={s.title}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.05)",
                  ...contentIn(160 + i * 35, speed),
                }}
              >
                <ShogoBuddy size={22} state={s.state} color={s.color} look={look} mini followPointer={false} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ color: "#f4f4f5", fontSize: 12, fontWeight: 600 }}>{s.title}</div>
                  <div style={{ color: "#71717a", fontSize: 10 }}>
                    {s.project} · {s.state}
                  </div>
                </div>
              </div>
            ))}
            {view === "chat" ? (
              <>
                <div style={{ color: "#d4d4d8", fontSize: 12, lineHeight: "17px", padding: "4px 2px", ...contentIn(195, speed) }}>
                  Found it: the session cookie is written after the redirect fires. Moving the write before the
                  navigation and adding a test for the loop.
                </div>
                <div
                  style={{
                    marginTop: 4,
                    padding: "9px 12px",
                    borderRadius: 14,
                    background: "rgba(255,255,255,0.07)",
                    color: "#71717a",
                    fontSize: 12,
                    ...contentIn(230, speed),
                  }}
                >
                  Reply in Web app…
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div ref={buddyEl} style={{ position: "absolute", left: 0, top: 0, pointerEvents: expanded ? "auto" : "none" }}>
        <ShogoBuddy
          ref={buddyRef}
          size={BUDDY_CANVAS}
          state={buddyState}
          color={accent}
          look={look}
          logoStyle={logoStyle}
          interactive={expanded}
        />
      </div>
    </div>
  )
}

function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "rounded-full border px-3 py-1.5",
        active ? "border-primary bg-primary/15" : "border-border bg-card hover:bg-muted",
      )}
    >
      <Text className={cn("text-xs", active ? "font-semibold text-primary" : "text-foreground")}>{label}</Text>
    </Pressable>
  )
}

/** Unfold, hold as the character, fold, hold as the mark. */
const LAB_UNFOLD_MS = 4600
const LAB_CYCLE_MS = 7400

/** Every ray style looping side by side, in sync. Click one to use it. */
function RayLab({
  look,
  accent,
  selected,
  onSelect,
}: {
  look: BuddyLook
  accent: string
  selected: LogoStyle
  onSelect: (style: LogoStyle) => void
}) {
  const handles = useRef<Partial<Record<LogoStyle, ShogoBuddyHandle | null>>>({})
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const [paused, setPaused] = useState(false)

  const each = (fn: (b: ShogoBuddyHandle) => void) => {
    for (const handle of Object.values(handles.current)) if (handle) fn(handle)
  }

  const clear = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }

  const restart = useCallback(() => {
    clear()
    const cycle = () => {
      each((b) => b.fromLogo())
      timers.current.push(setTimeout(() => each((b) => b.toLogo()), LAB_UNFOLD_MS))
      timers.current.push(setTimeout(cycle, LAB_CYCLE_MS))
    }
    each((b) => b.engine.showLogo(true))
    timers.current.push(setTimeout(cycle, 700))
  }, [])

  useEffect(() => {
    if (paused) {
      clear()
      return
    }
    restart()
    return clear
  }, [paused, restart])

  return (
    <View className="gap-3" style={{ width: STAGE_W }}>
      <View className="flex-row items-center justify-between">
        <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Ray lab: logo to character and back (click one to use it in the island)
        </Text>
        <View className="flex-row gap-2">
          <Chip label="Replay" onPress={() => (setPaused(false), restart())} />
          <Chip label={paused ? "Resume loop" : "Pause loop"} active={paused} onPress={() => setPaused((p) => !p)} />
          <Chip label="Unfold" onPress={() => (setPaused(true), each((b) => b.fromLogo()))} />
          <Chip label="Fold" onPress={() => (setPaused(true), each((b) => b.toLogo()))} />
        </View>
      </View>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {LOGO_STYLE_NAMES.map((name) => (
          <div
            key={name}
            onClick={() => onSelect(name)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "6px 10px 12px",
              borderRadius: 16,
              cursor: "pointer",
              background: "#0a0a0c",
              border: `1px solid ${selected === name ? accent : "rgba(255,255,255,0.06)"}`,
              transition: "border-color 200ms",
            }}
          >
            <ShogoBuddy
              ref={(handle) => {
                handles.current[name] = handle
              }}
              size={130}
              state="idle"
              color={accent}
              look={look}
              logoStyle={name}
              followPointer={false}
            />
            <span style={{ color: selected === name ? "#fafafa" : "#d4d4d8", fontSize: 13, fontWeight: 600 }}>
              {LOGO_STYLES[name].label}
            </span>
            <span style={{ color: "#71717a", fontSize: 11, textAlign: "center", marginTop: 2, lineHeight: "14px" }}>
              {LOGO_STYLES[name].hint}
            </span>
          </div>
        ))}
      </div>
    </View>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</Text>
      <View className="flex-row flex-wrap gap-2">{children}</View>
    </View>
  )
}

export default function IslandDemoRoute() {
  if (!__DEV__) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <Text className="text-foreground text-base">The island motion lab is only available in development builds.</Text>
      </SafeAreaView>
    )
  }

  return <IslandDemo />
}

function IslandDemo() {
  const accent = useIslandAccent()
  const [mode, setMode] = useState<Mode>("hidden")
  const [view, setView] = useState<CardView>("inbox")
  const [motion, setMotion] = useState<MotionStyle>("spring")
  const [speed, setSpeed] = useState(1)
  const [state, setState] = useState<BuddyState>("idle")
  const [look, setLook] = useState<BuddyLook>(DEFAULT_BUDDY_LOOK)
  const [logoUnfold, setLogoUnfold] = useState(true)
  const [logoStyle, setLogoStyle] = useState<LogoStyle>("mosaic")
  const [hovered, setHovered] = useState(false)
  const [log, setLog] = useState("")
  const islandBuddy = useRef<ShogoBuddyHandle>(null)
  const bigBuddy = useRef<ShogoBuddyHandle>(null)
  const script = useRef<ReturnType<typeof setTimeout>[]>([])

  const everyBuddy = (fn: (b: ShogoBuddyHandle) => void) => {
    if (islandBuddy.current) fn(islandBuddy.current)
    if (bigBuddy.current) fn(bigBuddy.current)
  }

  const stopScript = useCallback(() => {
    for (const t of script.current) clearTimeout(t)
    script.current = []
  }, [])
  useEffect(() => stopScript, [stopScript])

  const runScript = () => {
    stopScript()
    const steps: [number, string, () => void][] = [
      [0, "Nothing running: idle wings", () => (setMode("hidden"), setState("idle"), setView("inbox"))],
      [1200, "A chat starts: collapsed, working", () => (setMode("collapsed"), setState("working"))],
      [3200, "Hover: expands with a spring", () => setMode("expanded")],
      [5200, "Open a chat: card grows taller", () => setView("chat")],
      [7000, "Agent needs approval", () => setState("approval")],
      [9400, "Approved and done", () => setState("finished")],
      [11800, "Back to the inbox: card shrinks", () => setView("inbox")],
      [13200, "Collapse", () => (setMode("collapsed"), setState("idle"))],
      [15000, "Nothing left: back into the notch", () => setMode("hidden")],
    ]
    script.current = steps.map(([at, label, fn]) =>
      setTimeout(() => {
        setLog(label)
        fn()
      }, at / speed),
    )
  }

  if (Platform.OS !== "web") {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <Text className="text-sm text-muted-foreground">The island demo runs on web.</Text>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <style>{KEYFRAMES}</style>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 24, alignItems: "center" }}>
        <View style={{ width: STAGE_W }} className="gap-1">
          <Text className="text-xl font-bold text-foreground">Island motion lab</Text>
          <Text className="text-sm text-muted-foreground">
            Hover or click the island. Click the buddy when expanded (three quick clicks makes it dizzy); hold the
            pointer on it for love.
          </Text>
        </View>

        <RayLab look={look} accent={accent} selected={logoStyle} onSelect={setLogoStyle} />

        <View style={{ width: STAGE_W }} className="gap-3">
          <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Customize Shogo (applies everywhere)
          </Text>
          <BuddyCustomizer look={look} onChange={setLook} color={accent} state={state} previewSize={170} />
        </View>

        <div
          style={{
            position: "relative",
            width: STAGE_W,
            height: STAGE_H,
            borderRadius: 18,
            overflow: "hidden",
            background:
              "radial-gradient(120% 90% at 20% 110%, #3b2a6b 0%, transparent 60%), radial-gradient(90% 80% at 90% 10%, #1e3a5f 0%, transparent 55%), #0d0f1a",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              height: MENU_H,
              background: "rgba(20,20,28,0.55)",
              backdropFilter: "blur(20px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 16px",
              color: "rgba(255,255,255,0.8)",
              fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 700 }}>Shogo&nbsp;&nbsp;&nbsp;File&nbsp;&nbsp;&nbsp;Edit&nbsp;&nbsp;&nbsp;View</span>
            <span>Wed 4:44 PM</span>
          </div>
          <div
            style={{
              position: "absolute",
              left: NOTCH_LEFT,
              top: 0,
              width: NOTCH_W,
              height: MENU_H,
              background: "#000",
              borderRadius: "0 0 12px 12px",
            }}
          />
          <Island
            mode={mode}
            view={view}
            motion={motion}
            speed={speed}
            buddyState={state}
            look={look}
            logoUnfold={logoUnfold}
            logoStyle={logoStyle}
            accent={accent}
            buddyRef={islandBuddy}
            hovered={hovered}
            onHoverChange={setHovered}
            onPress={() => setMode("expanded")}
          />
          {log ? (
            <div
              style={{
                position: "absolute",
                left: 16,
                bottom: 14,
                padding: "6px 10px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.5)",
                color: "#e4e4e7",
                fontSize: 12,
              }}
            >
              {log}
            </div>
          ) : null}
        </div>

        <View style={{ width: STAGE_W }} className="flex-row gap-6">
          <View className="flex-1 gap-4">
            <Row label="Island mode">
              {(["hidden", "collapsed", "expanded"] as Mode[]).map((m) => (
                <Chip key={m} label={m} active={mode === m} onPress={() => setMode(m)} />
              ))}
            </Row>
            <Row label="Card content">
              <Chip label="inbox (short)" active={view === "inbox"} onPress={() => setView("inbox")} />
              <Chip label="chat (tall)" active={view === "chat"} onPress={() => setView("chat")} />
            </Row>
            <Row label="Motion">
              <Chip label="Spring (new)" active={motion === "spring"} onPress={() => setMotion("spring")} />
              <Chip label="Tween (current)" active={motion === "tween"} onPress={() => setMotion("tween")} />
              {[1, 0.5, 0.2].map((s) => (
                <Chip key={s} label={`${s}x`} active={speed === s} onPress={() => setSpeed(s)} />
              ))}
            </Row>
            <Row label="Logo">
              <Chip label="Unfold from logo" active={logoUnfold} onPress={() => setLogoUnfold(true)} />
              <Chip label="Fade in (no logo)" active={!logoUnfold} onPress={() => setLogoUnfold(false)} />
            </Row>
            <Row label="Ray style">
              {LOGO_STYLE_NAMES.map((name) => (
                <Chip
                  key={name}
                  label={LOGO_STYLES[name].label}
                  active={logoStyle === name}
                  onPress={() => setLogoStyle(name)}
                />
              ))}
            </Row>
            <Row label="Scenario">
              <Chip label="Play full sequence" onPress={runScript} />
              <Chip label="Stop" onPress={() => (stopScript(), setLog(""))} />
            </Row>
          </View>

          <View className="flex-1 gap-4">
            <Row label="Buddy state">
              {BUDDY_STATE_NAMES.map((s) => (
                <Chip key={s} label={s} active={state === s} onPress={() => setState(s)} />
              ))}
            </Row>
            <Row label="Emotes">
              {BUDDY_EMOTE_NAMES.map((e: BuddyEmote) => (
                <Chip key={e} label={e} onPress={() => everyBuddy((b) => b.emote(e))} />
              ))}
            </Row>
            <Row label="Actions">
              <Chip label="Poke" onPress={() => everyBuddy((b) => b.poke())} />
              <Chip label="Hop" onPress={() => everyBuddy((b) => b.hop())} />
              <Chip label="Jiggle" onPress={() => everyBuddy((b) => b.jiggle(0.12))} />
              <Chip label="Appear" onPress={() => everyBuddy((b) => b.appear())} />
              <Chip label="Logo → buddy" onPress={() => everyBuddy((b) => b.fromLogo())} />
              <Chip label="Buddy → logo" onPress={() => everyBuddy((b) => b.toLogo())} />
            </Row>
          </View>
        </View>

        <View style={{ width: STAGE_W }} className="gap-3">
          <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Close-up
          </Text>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: 48,
              padding: "24px 0 32px",
              borderRadius: 18,
              background: "#0a0a0c",
            }}
          >
            <ShogoBuddy
              ref={bigBuddy}
              size={220}
              state={state}
              color={accent}
              look={look}
              logoStyle={logoStyle}
              interactive
            />
            <div style={{ display: "flex", gap: 18, alignItems: "flex-end", paddingBottom: 20 }}>
              {SESSIONS.map((s) => (
                <div key={s.title} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <ShogoBuddy size={44} state={s.state} color={s.color} look={look} mini followPointer={false} />
                  <span style={{ color: "#71717a", fontSize: 10 }}>{s.state}</span>
                </div>
              ))}
            </div>
          </div>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
