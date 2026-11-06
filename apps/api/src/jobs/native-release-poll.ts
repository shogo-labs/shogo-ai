// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `native-release-poll` — ask EAS how a release's test stage went, and close any
 * charge the webhook could not.
 *
 * EAS webhooks only carry `BUILD` and `SUBMIT`, so a workflow run's outcome has
 * to be polled. This is also the only status channel BYOK has, because BYOK
 * creates no webhooks on the user's account.
 *
 * The sweep rides the same pass and the same lock rather than owning a job id of
 * its own: it is the same "what is still open" question, it must not race the
 * poller over a release, and a second cron entry is another thing to register
 * and to keep from double-charging.
 *
 * The whole body runs under `withGlobalJobLock`, so exactly one region polls and
 * a release cannot be started twice from two regions.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { pollNativeReleases, type PollResult } from '../services/native-release/poller'
import { sweepNativeMeters, type MeterSweepResult } from '../services/native-release/usage.service'

export interface NativeReleasePollRun {
  poll: PollResult
  sweep: MeterSweepResult
}

export async function runNativeReleasePoll(): Promise<NativeReleasePollRun | null> {
  const lock = await withGlobalJobLock('native-release-poll', async () => {
    const poll = await pollNativeReleases()
    if (poll.checked > 0) {
      console.log(
        `[native-release-poll] checked=${poll.checked} passed=${poll.passed} failed=${poll.failed} pending=${poll.pending} started=${poll.started}`,
      )
    }

    const sweep = await sweepNativeMeters()
    if (sweep.retried > 0 || sweep.recovered > 0 || sweep.unpriced > 0) {
      console.log(
        `[native-release-poll] sweep retried=${sweep.retried} metered=${sweep.metered} recovered=${sweep.recovered} unpriced=${sweep.unpriced} failed=${sweep.failed} testRunsPending=${sweep.testRunsPending}`,
      )
    }

    return { poll, sweep }
  })

  return lock.acquired ? lock.result : null
}

/**
 * Schedule the poller. Nothing else calls it, so without this a release whose
 * test stage passed never starts its store build and a finished build nobody
 * billed stays unbilled forever.
 */
export function startNativeReleasePollCron(intervalMs: number = 60 * 1000): void {
  const tick = (label: string) =>
    runNativeReleasePoll().catch((err) =>
      console.error(`[native-release-poll] ${label} failed:`, err),
    )
  setTimeout(() => {
    void tick('initial run')
    setInterval(() => void tick('periodic run'), intervalMs)
  }, 45_000)
  console.log(`[native-release-poll] cron scheduled (every ${Math.round(intervalMs / 1000)}s)`)
}
