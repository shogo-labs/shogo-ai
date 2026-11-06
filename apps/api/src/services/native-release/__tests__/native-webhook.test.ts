// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The EAS webhook, driven with the payloads Expo actually sends.
 *
 * The bodies below are copied from `docs.expo.dev/eas/webhooks/`. That is the
 * point of the file: an earlier revision keyed off `payload.event` and
 * `payload.buildDetails`, neither of which exists, so every real build took the
 * submit branch — nothing was metered, no store build was submitted, and a test
 * that posted `{ event: 'BUILD' }` was green through all of it. These cases fail
 * if anyone reintroduces a field Expo does not send.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHmac } from 'node:crypto'

const builds = new Map<string, Record<string, any>>()
const releases = new Map<string, Record<string, any>>()
const apps: Record<string, any>[] = []
const alerts: { event: string; detail: any }[] = []
const meterCalls: string[] = []
const submitCalls: string[] = []
let submitThrows: string | null = null

const fakePrisma = {
  nativeBuild: {
    async findUnique({ where }: any) {
      return builds.get(where.easBuildId) ?? null
    },
    async findFirst({ where }: any) {
      return [...builds.values()].find((b) => b.submissionId === where.submissionId) ?? null
    },
    async update({ where, data }: any) {
      const target = builds.get(where.easBuildId) ?? [...builds.values()].find((b) => b.id === where.id)
      if (target) Object.assign(target, data)
      return target
    },
  },
  nativeApp: {
    async findFirst({ where }: any) {
      return apps.find((a) => a.easAppId === where.easAppId) ?? null
    },
  },
  nativeRelease: {
    async count({ where }: any) {
      return [...releases.values()].filter(
        (r) => r.projectId === where.projectId && r.status === where.status,
      ).length
    },
    async update({ where, data }: any) {
      const target = releases.get(where.id)
      if (target) Object.assign(target, data)
      return target
    },
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: fakePrisma }))
mock.module('../usage.service', () => ({
  meterBuild: async ({ easBuildId }: { easBuildId: string }) => {
    meterCalls.push(easBuildId)
    return 'metered'
  },
}))
mock.module('../release.service', () => ({
  submitStoreBuild: async ({ easBuildId }: { easBuildId: string }) => {
    submitCalls.push(easBuildId)
    if (submitThrows) throw new Error(submitThrows)
  },
}))

const { handleEasWebhook, detectWebhookEvent, verifyEasSignature } = await import('../webhook')
const { setNativeAlertSink } = await import('../alerts')
const { webhookUrlFor } = await import('../apps.service')

const SECRET = 'webhook-secret-'.padEnd(32, 'x')

/** A documented BUILD delivery — note: no `event`, no `buildDetails`. */
const BUILD_PAYLOAD = {
  id: '147a3212-49fd-446f-b4e3-a6519acf264a',
  accountName: 'shogo',
  projectName: 'example',
  buildDetailsPageUrl: 'https://expo.dev/accounts/shogo/projects/example/builds/147a3212',
  appId: 'bc0a82de-65a5-4497-ad86-54ff1f53edf7',
  initiatingUserId: 'd1041496-1a59-423a-8caf-479bb978203a',
  platform: 'ios',
  status: 'finished',
  artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/abc.ipa', logsS3KeyPrefix: 'production/abc' },
  metadata: { buildProfile: 'shogo-store', distribution: 'store', appVersion: '1.0.2' },
  resourceClass: 'ios-medium',
  actualResourceClass: 'IOS_LARGE',
  createdAt: '2021-11-24T09:53:01.155Z',
  completedAt: '2021-11-24T09:57:42.715Z',
}

/** A documented SUBMIT delivery. */
const SUBMIT_PAYLOAD = {
  id: '0374430d-7776-44ad-be7d-8513629adc54',
  accountName: 'shogo',
  projectName: 'example',
  submissionDetailsPageUrl: 'https://expo.dev/accounts/shogo/projects/example/builds/0374430d',
  appId: 'bc0a82de-65a5-4497-ad86-54ff1f53edf7',
  archiveUrl: 'http://archive.url/abc.apk',
  turtleBuildId: '8c84111e-6d39-449c-9895-071d85fd3e61',
  platform: 'android',
  status: 'finished',
  submissionInfo: { error: { message: 'none', errorCode: 'NONE' }, logsUrl: 'https://logs' },
}

function sign(body: string): string {
  return `sha1=${createHmac('sha1', SECRET).update(body, 'utf8').digest('hex')}`
}

async function deliver(payload: unknown, event?: string) {
  const rawBody = JSON.stringify(payload)
  return handleEasWebhook({
    rawBody,
    signature: sign(rawBody),
    secret: SECRET,
    event,
    now: new Date('2026-11-06T00:00:00Z'),
  })
}

function seedBuild(overrides: Record<string, any> = {}) {
  const build = {
    id: 'nb_1',
    easBuildId: BUILD_PAYLOAD.id,
    releaseId: 'rel_1',
    platform: 'ios',
    purpose: 'store',
    resourceClass: 'IOS_MEDIUM',
    status: 'in_progress',
    artifactKey: null,
    submissionId: null,
    finishedAt: null,
    ...overrides,
  }
  builds.set(build.easBuildId, build)
  releases.set('rel_1', { id: 'rel_1', projectId: 'proj_1', status: 'building', step: 'store_build' })
  return build
}

beforeEach(() => {
  builds.clear()
  releases.clear()
  apps.length = 0
  alerts.length = 0
  meterCalls.length = 0
  submitCalls.length = 0
  submitThrows = null
  setNativeAlertSink(async (event, detail) => {
    alerts.push({ event, detail })
  })
})

afterEach(() => {
  setNativeAlertSink(null)
})

describe('the webhook event comes from the URL, not from a body field', () => {
  it('registers one URL per event, because the payload has no `event`', () => {
    expect(webhookUrlFor('https://api.shogo.ai/', 'BUILD')).toBe(
      'https://api.shogo.ai/api/webhooks/eas?event=build',
    )
    expect(webhookUrlFor('https://api.shogo.ai', 'SUBMIT')).toBe(
      'https://api.shogo.ai/api/webhooks/eas?event=submit',
    )
  })

  it('detects a build body by shape when there is no hint', () => {
    expect(detectWebhookEvent(BUILD_PAYLOAD)).toBe('build')
    expect(detectWebhookEvent(SUBMIT_PAYLOAD)).toBe('submit')
  })

  it('never mistakes a build for a submission — the round-2 regression', () => {
    // The old code read `payload.event ?? (payload.buildDetails ? 'BUILD' : 'SUBMIT')`
    // and this body has neither, so it fell into the submit branch.
    expect('event' in BUILD_PAYLOAD).toBe(false)
    expect('buildDetails' in BUILD_PAYLOAD).toBe(false)
    expect(detectWebhookEvent(BUILD_PAYLOAD)).toBe('build')
  })

  it('refuses an unrecognisable body instead of guessing', async () => {
    const res = await deliver({ hello: 'world' })
    expect(res.status).toBe(202)
    expect(res.body.matched).toBe(false)
    expect(alerts.map((a) => a.event)).toEqual(['native_webhook_unrecognised'])
  })

  it('still rejects a body whose signature does not match', async () => {
    const rawBody = JSON.stringify(BUILD_PAYLOAD)
    const res = await handleEasWebhook({
      rawBody,
      signature: sign(`${rawBody} `),
      secret: SECRET,
      event: 'build',
    })
    expect(res.status).toBe(401)
    expect(verifyEasSignature(rawBody, sign(rawBody), SECRET)).toBe(true)
  })
})

describe('a finished build', () => {
  it('bills by what actually ran and stores the real artifact URL', async () => {
    const build = seedBuild()
    const res = await deliver(BUILD_PAYLOAD, 'build')
    expect(res.status).toBe(200)

    expect(meterCalls).toEqual([BUILD_PAYLOAD.id])
    expect(build.resourceClass).toBe('IOS_LARGE')
    expect(build.artifactKey).toBe(BUILD_PAYLOAD.artifacts.buildUrl)
    expect(build.status).toBe('finished')
    expect(releases.get('rel_1')!.step).toBe('store_submission')
    expect(submitCalls).toEqual([BUILD_PAYLOAD.id])
  })

  it('is detected without the query hint too', async () => {
    seedBuild()
    const res = await deliver(BUILD_PAYLOAD)
    expect(res.body).toMatchObject({ ok: true, metered: 'metered' })
    expect(meterCalls).toHaveLength(1)
  })

  it('marks a failed build with the reason Expo gives', async () => {
    const build = seedBuild()
    const res = await deliver(
      { ...BUILD_PAYLOAD, status: 'errored', error: { message: 'Gradle build failed', errorCode: 'E' } },
      'build',
    )
    expect(res.status).toBe(200)
    expect(build.status).toBe('errored')
    expect(meterCalls).toHaveLength(0)
    expect(releases.get('rel_1')!.error).toBe('Gradle build failed')
    expect(releases.get('rel_1')!.status).toBe('failed')
  })
})

describe('a submission', () => {
  it('reads the id and status from the documented payload', async () => {
    const build = seedBuild({
      easBuildId: 'other',
      purpose: 'store',
      submissionId: SUBMIT_PAYLOAD.id,
      submissionStatus: null,
    })
    const res = await deliver(SUBMIT_PAYLOAD, 'submit')
    expect(res.status).toBe(200)
    expect(build.submissionStatus).toBe('finished')
    expect(releases.get('rel_1')).toMatchObject({ status: 'done', step: 'live' })
    expect(meterCalls).toHaveLength(0)
  })

  it('carries the submission error into the release', async () => {
    seedBuild({ easBuildId: 'other', submissionId: SUBMIT_PAYLOAD.id })
    await deliver(
      {
        ...SUBMIT_PAYLOAD,
        status: 'errored',
        submissionInfo: {
          error: {
            message: 'Android version code needs to be updated',
            errorCode: 'SUBMISSION_SERVICE_ANDROID_OLD_VERSION_CODE_ERROR',
          },
        },
      },
      'submit',
    )
    expect(releases.get('rel_1')).toMatchObject({
      status: 'failed',
      error: 'Android version code needs to be updated',
    })
  })
})

describe('a build we have no row for', () => {
  it('is quiet while the same app has a release in its test stage', async () => {
    // A workflow build beats the poller that adopts it.
    apps.push({ easAppId: BUILD_PAYLOAD.appId, projectId: 'proj_1' })
    releases.set('rel_test', { id: 'rel_test', projectId: 'proj_1', status: 'testing' })

    const res = await deliver(BUILD_PAYLOAD, 'build')
    expect(res.status).toBe(202)
    expect(res.body.pending_adoption).toBe(true)
    expect(alerts).toHaveLength(0)
  })

  it('alerts when the gap is on another project — the account-wide suppression was too broad', async () => {
    apps.push({ easAppId: BUILD_PAYLOAD.appId, projectId: 'proj_1' })
    // A different project is testing. That says nothing about this app.
    releases.set('rel_other', { id: 'rel_other', projectId: 'proj_2', status: 'testing' })

    const res = await deliver(BUILD_PAYLOAD, 'build')
    expect(res.body.matched).toBe(false)
    expect(alerts.map((a) => a.event)).toEqual(['native_build_unknown'])
  })

  it('alerts when the app is not one of ours at all', async () => {
    await deliver(BUILD_PAYLOAD, 'build')
    expect(alerts.map((a) => a.event)).toEqual(['native_build_unknown'])
  })
})
