// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The per-member messages export (SHO-199), kept out of the table component so
 * it can be tested without mounting the analytics screen: which window it asks
 * for, and where the download goes.
 */

import { Linking } from 'react-native'
import { memberMessagesCsvUrl, type UsageLogCsvMachine } from './usage-log-csv'
import type { EngagementPeriod } from './engagement-utils'

/**
 * The export window for a period, as ISO. The messages route takes explicit
 * bounds (an `all` export simply omits `since`).
 */
export function memberMessagesSince(period: EngagementPeriod, now: Date = new Date()): string | undefined {
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : null
  return days ? new Date(now.getTime() - days * 864e5).toISOString() : undefined
}

/**
 * Open one person's messages as a CSV, using the same base rules as the usage
 * log: a paired computer's workspace exports from that machine, everything else
 * from this app's API. Returns the URL so a caller (or a test) can see it.
 */
export function exportMemberMessages(input: {
  workspaceId: string
  userId: string
  period: EngagementPeriod
  machine?: UsageLogCsvMachine | null
  apiUrl?: string
  now?: Date
  /** Defaults to a browser tab on web, the system browser on native. */
  open?: (url: string) => void
}): string {
  const url = memberMessagesCsvUrl({
    workspaceId: input.workspaceId,
    userId: input.userId,
    params: { since: memberMessagesSince(input.period, input.now) },
    apiUrl: input.apiUrl,
    machine: input.machine,
  })
  const open = input.open ?? defaultOpen
  open(url)
  return url
}

function defaultOpen(url: string): void {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
  else void Linking.openURL(url)
}
