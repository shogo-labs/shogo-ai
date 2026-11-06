// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workflow poller.
 *
 * EAS webhooks only cover `BUILD` and `SUBMIT` (`WebhookType` has no workflow
 * event), so a test run's result has to be asked for. This is also the only way
 * **BYOK** learns anything, because BYOK creates no webhooks on the user's
 * account at all.
 *
 * One pass = every release whose status is `testing`. A pass that fails leaves
 * the release `failed` **without** starting a store build, which is what makes
 * "a failed Maestro flow is never a charged store build" true.
 */

import { prisma } from '../../lib/prisma'
import { pollWorkflowRun, startStoreBuilds } from './release.service'
import { easClientFor, resolveEasCredentials } from './client'
import { readByokExpoToken } from './credentials.service'
import type { NativeAppRow } from './apps.service'

const db = prisma as any

export const NATIVE_POLL_BATCH = 20

export interface PollResult {
  checked: number
  passed: number
  failed: number
  pending: number
  started: number
}

export async function pollNativeReleases(limit = NATIVE_POLL_BATCH): Promise<PollResult> {
  const releases = await db.nativeRelease.findMany({
    where: { status: 'testing' },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })

  const result: PollResult = { checked: releases.length, passed: 0, failed: 0, pending: 0, started: 0 }

  for (const release of releases) {
    if (!release.workflowRunId) continue

    let outcome: 'pending' | 'passed' | 'failed'
    try {
      outcome = await pollWorkflowRun(release.id)
    } catch (err) {
      console.error('[native-release] poll failed', release.id, err)
      result.pending += 1
      continue
    }

    if (outcome === 'pending') {
      result.pending += 1
      continue
    }

    if (outcome === 'failed') {
      await db.nativeRelease.update({
        where: { id: release.id },
        data: {
          status: 'failed',
          step: 'maestro',
          testOutcome: 'failed',
          error: 'The test build or Maestro flow failed, so no store build was started.',
        },
      })
      result.failed += 1
      continue
    }

    await db.nativeRelease.update({
      where: { id: release.id },
      data: { testOutcome: 'passed' },
    })
    result.passed += 1

    const app = (await db.nativeApp.findUnique({
      where: { projectId: release.projectId },
    })) as NativeAppRow | null
    if (!app?.easAppId) continue

    const credentials = await resolveEasCredentials({
      workspaceId: release.workspaceId,
      readByokToken: readByokExpoToken,
    })
    await startStoreBuilds({
      releaseId: release.id,
      client: easClientFor(credentials),
      app,
      platforms: release.platforms,
    })
    result.started += 1
  }

  return result
}
