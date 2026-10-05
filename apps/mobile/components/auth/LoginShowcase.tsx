// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef, useState, type ComponentType } from "react"
import { useWindowDimensions } from "react-native"
import { Check, Gift, Mail, Mic, Plane, Presentation, Terminal } from "lucide-react-native"
import { ShogoBuddy, type ShogoBuddyHandle } from "../island/buddy/ShogoBuddy"
import { DEFAULT_BUDDY_LOOK, type BuddyLook } from "../island/buddy/look"
import type { BuddyEmote } from "../island/buddy/engine"
import { useReducedMotion } from "../../hooks/useReducedMotion"

type Side = "Life" | "Work"

interface Task {
  side: Side
  text: string
  result: string
  icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
  look: BuddyLook
  emote: BuddyEmote
}

const dressed = (parts: Partial<BuddyLook>): BuddyLook => ({ ...DEFAULT_BUDDY_LOOK, ...parts })

const TASKS: Task[] = [
  { side: "Life", text: "plans your Tokyo trip", result: "5 days, flights and hotel held", icon: Plane, look: dressed({ eyewear: "sunglasses", blush: false }), emote: "happy" },
  { side: "Work", text: "takes your meeting notes", result: "Summary and 4 action items sent", icon: Mic, look: dressed({ topper: "headphones" }), emote: "proud" },
  { side: "Life", text: "clears your inbox", result: "212 emails, 3 that need you", icon: Mail, look: dressed({ topper: "ears" }), emote: "wink" },
  { side: "Work", text: "ships your feature", result: "Live, all tests passing", icon: Terminal, look: dressed({ topper: "none", face: "screen", blush: false }), emote: "proud" },
  { side: "Life", text: "remembers Mia's birthday", result: "Gift ordered, card drafted", icon: Gift, look: dressed({ topper: "party", neck: "bowtie" }), emote: "love" },
  { side: "Work", text: "briefs the board", result: "12-slide deck ready", icon: Presentation, look: dressed({ eyewear: "nerd", neck: "bowtie" }), emote: "happy" },
]

const INTERVAL = 3200
const EMBER = "#ff7a45"
const BUDDY_COLOR = "#F47B3A"
const BUDDY_SIZE = 188

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const KEYFRAMES = `
@keyframes login-showcase-flip-in { from { opacity: 0; transform: translateY(70%); filter: blur(6px); } to { opacity: 1; transform: none; filter: blur(0); } }
@keyframes login-showcase-flip-out { from { opacity: 1; transform: none; filter: blur(0); } to { opacity: 0; transform: translateY(-70%); filter: blur(6px); } }
@keyframes login-showcase-fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes login-showcase-seg-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.login-showcase-flip-in { animation: login-showcase-flip-in .7s cubic-bezier(.2,.8,.2,1) both; }
.login-showcase-flip-out { animation: login-showcase-flip-out .7s cubic-bezier(.2,.8,.2,1) both; }
.login-showcase-fade-up { animation: login-showcase-fade-up .6s ease-out both; }
.login-showcase-seg-fill { animation: login-showcase-seg-fill linear both; }
.login-showcase-seg:hover .login-showcase-track { background: var(--login-showcase-track-hover); }
@media (prefers-reduced-motion: reduce) {
  .login-showcase-flip-in, .login-showcase-flip-out, .login-showcase-fade-up { animation: none; }
}
`

function palette(scheme: "light" | "dark") {
  const fg = scheme === "dark" ? "255,255,255" : "0,0,0"
  return {
    fg: `rgb(${fg})`,
    fg70: `rgba(${fg},0.70)`,
    fg40: `rgba(${fg},0.40)`,
    fg30: `rgba(${fg},0.30)`,
    fg20: `rgba(${fg},0.20)`,
    fg10: `rgba(${fg},0.10)`,
    border: `rgba(${fg},0.08)`,
    surface: `rgba(${fg},0.04)`,
    pill: scheme === "dark" ? "#000000" : "#ffffff",
    emberSoft: scheme === "dark" ? "rgba(255,122,69,0.12)" : "rgba(255,122,69,0.10)",
  }
}

function Phrase({ task, fontSize }: { task: Task; fontSize: number }) {
  const Icon = task.icon
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3em" }}>
      {task.text}
      <span
        style={{
          display: "inline-grid",
          placeItems: "center",
          width: "1em",
          height: "1em",
          borderRadius: "0.3em",
          transform: "rotate(-6deg)",
          background: "rgba(255,122,69,0.12)",
          boxShadow: "inset 0 0 0 1px rgba(255,122,69,0.25)",
        }}
      >
        <Icon size={Math.round(fontSize * 0.55)} color={EMBER} strokeWidth={2} />
      </span>
    </span>
  )
}

/** Animated right-hand panel for the desktop sign-in screen. Web only. */
export function LoginShowcase({ colorScheme }: { colorScheme: "light" | "dark" }) {
  const [index, setIndex] = useState(0)
  const [prev, setPrev] = useState<number | null>(null)
  const [cycle, setCycle] = useState(0)
  const buddyRef = useRef<ShogoBuddyHandle>(null)
  const reduced = useReducedMotion()
  const { width } = useWindowDimensions()
  const fontSize = Math.max(22, Math.min(48, width * 0.034))
  const c = palette(colorScheme)
  const task = TASKS[index]

  const goTo = (next: number) => {
    if (next === index) return
    setPrev(index)
    setIndex(next)
    setCycle((n) => n + 1)
  }

  useEffect(() => {
    const id = setTimeout(() => goTo((index + 1) % TASKS.length), INTERVAL)
    return () => clearTimeout(id)
  }, [index, cycle])

  useEffect(() => {
    if (prev === null) return
    buddyRef.current?.hop()
    const id = setTimeout(() => buddyRef.current?.emote(task.emote), 280)
    return () => clearTimeout(id)
  }, [index, prev, task.emote])

  return (
    <aside
      aria-label="What Shogo can do"
      style={{
        position: "relative",
        isolation: "isolate",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: 28,
        border: `1px solid ${c.border}`,
        background: c.surface,
        padding: "56px 32px",
        boxSizing: "border-box",
        color: c.fg,
        ["--login-showcase-track-hover" as string]: c.fg20,
      }}
    >
      <style>{KEYFRAMES}</style>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          zIndex: -1,
          pointerEvents: "none",
          backgroundImage: `radial-gradient(${c.fg10} 1px, transparent 1px)`,
          backgroundSize: "22px 22px",
          maskImage: "radial-gradient(ellipse at center, black 20%, transparent 70%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 20%, transparent 70%)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: "44%",
          width: "30rem",
          height: "30rem",
          transform: "translate(-50%, -50%)",
          zIndex: -1,
          pointerEvents: "none",
          borderRadius: "9999px",
          background: `radial-gradient(closest-side, ${c.emberSoft}, transparent)`,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: "44%",
          width: "26rem",
          height: "26rem",
          transform: "translate(-50%, -50%)",
          zIndex: -1,
          pointerEvents: "none",
          borderRadius: "9999px",
          border: `1px solid ${c.border}`,
        }}
      />
      <div
        aria-hidden
        style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.04, backgroundImage: GRAIN }}
      />

      <p style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)", margin: -1 }}>
        Shogo, the AI that plans your trips, takes your meeting notes, clears your inbox, ships your code,
        remembers birthdays and briefs your board.
      </p>

      <div aria-hidden style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
        <ShogoBuddy
          ref={buddyRef}
          size={BUDDY_SIZE}
          state="idle"
          color={BUDDY_COLOR}
          look={task.look}
          reducedMotion={reduced}
        />
        <div
          style={{
            marginTop: -BUDDY_SIZE * 0.17,
            width: BUDDY_SIZE * 0.62,
            height: 12,
            borderRadius: 9999,
            background: "rgba(255,122,69,0.35)",
            filter: "blur(12px)",
          }}
        />

        <div
          style={{
            marginTop: 36,
            width: "100%",
            textAlign: "center",
            fontSize,
            fontWeight: 600,
            lineHeight: 1.15,
            letterSpacing: "-0.045em",
          }}
        >
          <p style={{ margin: 0, color: c.fg40 }}>Shogo, the AI that</p>
          <div style={{ position: "relative", height: "1.3em", width: "100%", overflow: "hidden" }}>
            {prev !== null && (
              <span
                key={`out-${cycle}`}
                className="login-showcase-flip-out"
                style={{ position: "absolute", left: 0, right: 0, top: 0, whiteSpace: "nowrap" }}
              >
                <Phrase task={TASKS[prev]} fontSize={fontSize} />
              </span>
            )}
            <span
              key={`in-${cycle}`}
              className="login-showcase-flip-in"
              style={{ position: "absolute", left: 0, right: 0, top: 0, whiteSpace: "nowrap" }}
            >
              <Phrase task={task} fontSize={fontSize} />
            </span>
          </div>
        </div>

        <div
          key={`result-${cycle}`}
          className="login-showcase-fade-up"
          style={{
            marginTop: 20,
            display: "inline-flex",
            maxWidth: "100%",
            alignItems: "center",
            gap: 8,
            borderRadius: 9999,
            border: `1px solid ${c.border}`,
            background: c.pill,
            padding: "8px 16px",
            fontSize: 14,
            color: c.fg70,
            animationDelay: "250ms",
          }}
        >
          <Check size={16} color={EMBER} strokeWidth={2} />
          <span>{task.result}</span>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          marginTop: 48,
          display: "flex",
          width: "100%",
          maxWidth: 384,
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div aria-hidden style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, fontWeight: 500, letterSpacing: "-0.01em" }}>
          <span style={{ transition: "color 500ms", color: task.side === "Life" ? c.fg : c.fg30 }}>Life</span>
          <span style={{ width: 4, height: 4, borderRadius: 9999, background: EMBER }} />
          <span style={{ transition: "color 500ms", color: task.side === "Work" ? c.fg : c.fg30 }}>Work</span>
        </div>
        <div style={{ display: "flex", width: "100%", gap: 6 }}>
          {TASKS.map((t, i) => (
            <button
              key={t.text}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Show: ${t.text}`}
              className="login-showcase-seg"
              style={{ flex: 1, height: 20, padding: "8px 0", border: 0, background: "transparent", cursor: "pointer" }}
            >
              <span
                className="login-showcase-track"
                style={{
                  position: "relative",
                  display: "block",
                  width: "100%",
                  height: 3,
                  overflow: "hidden",
                  borderRadius: 9999,
                  background: c.fg10,
                  transition: "background 150ms",
                }}
              >
                {i < index && <span style={{ position: "absolute", inset: 0, background: c.fg30 }} />}
                {i === index && (
                  <span
                    key={`seg-${cycle}`}
                    className="login-showcase-seg-fill"
                    style={{
                      position: "absolute",
                      inset: 0,
                      transformOrigin: "left",
                      background: EMBER,
                      animationDuration: `${INTERVAL}ms`,
                    }}
                  />
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
