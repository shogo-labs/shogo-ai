// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * usePhaseColor Hook (React Native)
 *
 * Returns phase-specific color classes for chat UI.
 */

import { useMemo } from "react"

export interface PhaseColors {
  bg: string
  text: string
  border: string
  ring: string
  accent: string
}

const PHASE_COLORS: Record<string, PhaseColors> = {
  discovery: {
    bg: "bg-blue-500",
    text: "text-blue-500",
    border: "border-blue-500",
    ring: "ring-blue-500",
    accent: "bg-blue-100 text-blue-800",
  },
  design: {
    bg: "bg-purple-500",
    text: "text-purple-500",
    border: "border-purple-500",
    ring: "ring-purple-500",
    accent: "bg-purple-100 text-purple-800",
  },
  implementation: {
    bg: "bg-green-500",
    text: "text-green-500",
    border: "border-green-500",
    ring: "ring-green-500",
    accent: "bg-green-100 text-green-800",
  },
}

const NEUTRAL_COLORS: PhaseColors = {
  bg: "bg-gray-500",
  text: "text-gray-500",
  border: "border-gray-500",
  ring: "ring-gray-500",
  accent: "bg-gray-100 text-gray-800",
}

export function usePhaseColor(phase: string): PhaseColors {
  return useMemo(() => {
    return PHASE_COLORS[phase] || NEUTRAL_COLORS
  }, [phase])
}

export function getPhaseColors(phase: string): PhaseColors {
  return PHASE_COLORS[phase] || NEUTRAL_COLORS
}
