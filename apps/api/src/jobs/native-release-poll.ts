// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `native-release-poll` — ask EAS how a release's test stage went.
 *
 * EAS webhooks only carry `BUILD` and `SUBMIT`, so a workflow run's outcome has
 * to be polled. This is also the only status channel BYOK has, because BYOK
 * creates no webhooks on the user's account.
 *
 * The whole body runs under `withGlobalJobLock`, so exactly one region polls and
 * a release cannot be started twice from two regions.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { pollNativeReleases, type PollResult } from '../services/native-release/poller'

export async function runNativeReleasePoll(): Promise<PollResult | null> {
  const lock = await withGlobalJobLock('native-release-poll', async () => {
    const result = await pollNativeReleases()
    if (result.checked > 0) {
      console.log(
        `[native-release-poll] checked=${result.checked} passed=${result.passed} failed=${result.failed} pending=${result.pending} started=${result.started}`,
      )
    }
    return result
  })

  return lock.acquired ? lock.result : null
}
