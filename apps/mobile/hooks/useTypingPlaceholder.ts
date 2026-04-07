// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useRef, useCallback } from "react"

const TYPING_SPEED = 45
const DELETING_SPEED = 25
const PAUSE_AFTER_TYPING = 2200
const PAUSE_AFTER_DELETING = 400

/** Shown before the rotating typewriter suggestions in Agent mode on the home composer. */
export const AGENT_PLACEHOLDER_PREFIX = "Ask Shogo to create "

const DEFAULT_SUGGESTIONS = [
  "Summarize today's GitHub activity",
  "Build a customer onboarding workflow",
  "Create an AI-powered email assistant",
  "Design a real-time analytics dashboard",
  "Monitor my cloud infrastructure health",
  "Automate code review with AI agents",
  "Track and triage production incidents",
  "Generate weekly team standup reports",
  "Build a smart meeting scheduler",
  "Create a social media content calendar",
  "Analyze sales data and forecast trends",
  "Set up automated invoice processing",
  "Build an AI research assistant",
  "Create a competitive intelligence tracker",
]

type Phase = "typing" | "pausing" | "deleting" | "waiting"

export function useTypingPlaceholder(
  suggestions: string[] = DEFAULT_SUGGESTIONS,
  { enabled = true }: { enabled?: boolean } = {}
): string {
  const [displayText, setDisplayText] = useState("")
  const indexRef = useRef(0)
  const charRef = useRef(0)
  const phaseRef = useRef<Phase>("typing")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled || suggestions.length === 0) {
      setDisplayText("")
      return
    }

    indexRef.current = 0
    charRef.current = 0
    phaseRef.current = "typing"
    setDisplayText("")

    function tick() {
      const current = suggestions[indexRef.current]
      const phase = phaseRef.current

      if (phase === "typing") {
        charRef.current++
        setDisplayText(current.slice(0, charRef.current))
        if (charRef.current >= current.length) {
          phaseRef.current = "pausing"
          timerRef.current = setTimeout(tick, PAUSE_AFTER_TYPING)
        } else {
          timerRef.current = setTimeout(tick, TYPING_SPEED)
        }
      } else if (phase === "pausing") {
        phaseRef.current = "deleting"
        timerRef.current = setTimeout(tick, 0)
      } else if (phase === "deleting") {
        charRef.current--
        setDisplayText(current.slice(0, charRef.current))
        if (charRef.current <= 0) {
          phaseRef.current = "waiting"
          timerRef.current = setTimeout(tick, PAUSE_AFTER_DELETING)
        } else {
          timerRef.current = setTimeout(tick, DELETING_SPEED)
        }
      } else {
        indexRef.current = (indexRef.current + 1) % suggestions.length
        charRef.current = 0
        phaseRef.current = "typing"
        timerRef.current = setTimeout(tick, 0)
      }
    }

    tick()

    return () => clear()
  }, [suggestions, enabled, clear])

  return displayText
}
