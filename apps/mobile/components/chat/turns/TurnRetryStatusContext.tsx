// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnRetryStatusContext
 *
 * Carries the active retry status from ChatPanel to the one assistant turn
 * that should show it (inline, where "Planning next moves" renders) without
 * threading props through the memoised TurnList → TurnGroup → AssistantContent
 * chain. Same rationale as `TurnFooterContext`.
 */

import { createContext, useContext, type ReactNode } from "react"
import type { TurnRetryStatus } from "./turnRetryStatus"

export interface TurnRetryStatusContextValue {
  /** Shown on the streaming turn (stall recovery keeps a turn "streaming"). */
  status: TurnRetryStatus | null
  /** Cut the current backoff short and retry immediately. */
  onRetryNow: () => void
  /** Suggested alternative when the provider is overloaded. */
  switchModel: { label: string; onSwitch: () => void } | null
}

const TurnRetryStatusContext = createContext<TurnRetryStatusContextValue | null>(null)

export function TurnRetryStatusProvider({
  value,
  children,
}: {
  value: TurnRetryStatusContextValue
  children: ReactNode
}) {
  return <TurnRetryStatusContext.Provider value={value}>{children}</TurnRetryStatusContext.Provider>
}

export function useTurnRetryStatus(): TurnRetryStatusContextValue | null {
  return useContext(TurnRetryStatusContext)
}
