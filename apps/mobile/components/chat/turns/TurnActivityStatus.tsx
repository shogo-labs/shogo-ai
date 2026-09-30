// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The status slot at the bottom of an assistant turn: the inline retry status
 * while this turn is being retried, otherwise "Planning next moves" when
 * `showPlanning`, otherwise `fallback`. The retry line takes over even when
 * the turn's last part is text — a stalled answer is exactly when it matters.
 * For the first 5s of a retry nothing changes, since most blips heal on their own.
 */

import type { ReactNode } from "react"
import { PlanningStatusLine } from "./PlanningStatusLine"
import { RetryStatusLine, useRetryClock } from "./RetryStatusLine"
import { useTurnRetryStatus } from "./TurnRetryStatusContext"
import { RETRY_STAGE_RECONNECTING_MS } from "./turnRetryStatus"

export interface TurnActivityStatusProps {
  isStreaming: boolean
  showPlanning: boolean
  fallback?: ReactNode
}

export function TurnActivityStatus({ isStreaming, showPlanning, fallback = null }: TurnActivityStatusProps) {
  const ctx = useTurnRetryStatus()
  const applies = !!ctx?.status && isStreaming
  const now = useRetryClock(applies)
  if (applies && ctx?.status && now - ctx.status.startedAt >= RETRY_STAGE_RECONNECTING_MS) {
    return <RetryStatusLine status={ctx.status} onRetryNow={ctx.onRetryNow} switchModel={ctx.switchModel} />
  }
  if (showPlanning) return <PlanningStatusLine />
  return <>{fallback}</>
}

export default TurnActivityStatus
