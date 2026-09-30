// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background work for workspace channels. Each body runs under its own
 * global job lock so only one region does it per tick.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { runDigestPass } from '../services/chat-digest'

const DIGEST_INTERVAL_MS = 10 * 60 * 1000

export async function runChannelEmailDigest(): Promise<void> {
  await withGlobalJobLock('channels-email-digest', async () => {
    await runDigestPass()
  })
}

const timers: ReturnType<typeof setInterval>[] = []

function every(ms: number, label: string, fn: () => Promise<void>) {
  const tick = () => {
    void fn().catch((error) => console.error(`[Channels] ${label} tick failed:`, error))
  }
  const timer = setInterval(tick, ms)
  ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  timers.push(timer)
}

export function startChannelWorkers(): () => void {
  if (timers.length) return stopChannelWorkers
  every(DIGEST_INTERVAL_MS, 'Email digest', runChannelEmailDigest)
  return stopChannelWorkers
}

export function stopChannelWorkers(): void {
  while (timers.length) clearInterval(timers.pop()!)
}
