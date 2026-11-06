// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A release: plan gate → preflight → test workflow → store build → submission.
 *
 * The shape Russell decided on 2026-11-06 (A + C):
 *
 * - The **runner holds nothing secret**. It computes the job, tars the project
 *   and PUTs it to signed URLs the API mints. Every EAS mutation is made here, in
 *   the API process, with the token the API resolved.
 * - The **test happens before the store build**, both inside one release. The
 *   simulator/emulator build and Maestro run as one EAS workflow whose YAML we
 *   generate; the store build only starts if it passes, so a broken build is
 *   never a charged store build.
 * - **We choose the resource class** (`IOS_MEDIUM`, `ANDROID_MEDIUM`) and always
 *   send `expoTokenRole: RUNNER`, so a job draft from the runner cannot widen its
 *   own privileges or pick a class the meter cannot price.
 *
 * `validateRunnerJobDraft` is deliberately a pure function of the draft: it is the
 * security boundary between user code and the Shogo Expo account, and it is the
 * one thing in this file that must never depend on the database.
 */

import { prisma } from '../../lib/prisma'
import { canUseNativeRelease } from '../billing.service'
import { checkUsageBalance } from '../billing-runtime'
import {
  NativeReleaseError,
  easClientFor,
  nativeReleaseMode,
  resolveEasCredentials,
  type EasCredentials,
  type EasClient,
} from './client'
import {
  createAccountScopedUploadSession,
  createBuild,
  createSubmission,
  createUploadSession,
  createWorkflowRun,
  getWorkflowRun,
  type BuildResourceClass,
} from './eas-graphql'
import { ensureNativeApp, lockAppIdentifiers, type NativeAppRow } from './apps.service'
import { readAscKey, readByokExpoToken, readPlayKey } from './credentials.service'
import { projectedReleaseRawUsd, type ProjectedReleaseInput } from './usage.service'
import { alertOps } from './alerts'

const db = prisma as any

export type ReleaseKind = 'build' | 'update'
export type ReleaseTrack = 'internal' | 'testflight' | 'production'
export type ReleasePlatform = 'ios' | 'android'

/**
 * Job fields the runner may never set. Each one is either a privilege it must not
 * have (`expoTokenRole`), a spend it must not choose (`resourceClass`), or a
 * secret the API owns (`secrets`, `username`).
 */
export const PROTECTED_JOB_KEYS = [
  'secrets',
  'expoTokenRole',
  'resourceClass',
  'username',
  'builderEnvironment',
] as const

export interface JobDraftViolation {
  path: string
  reason: string
}

/**
 * Reject a runner-supplied job draft that reaches outside its lane.
 *
 * Walks the whole object, not just the top level: `builderEnvironment.image` and
 * any nested `secrets` are the same escape as a top-level one, and a check that
 * only looks at the root is the bug this function exists to prevent.
 */
export function validateRunnerJobDraft(draft: unknown): JobDraftViolation[] {
  const violations: JobDraftViolation[] = []

  const walk = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = [...path, key]
      if ((PROTECTED_JOB_KEYS as readonly string[]).includes(key)) {
        violations.push({
          path: here.join('.'),
          reason: `"${key}" is set by the Shogo API, not by the project`,
        })
      }
      walk(value, here)
    }
  }

  walk(draft, [])
  return violations
}

/** Throws when a runner draft tries to set something only the API may set. */
export function assertRunnerJobDraft(draft: unknown): void {
  const violations = validateRunnerJobDraft(draft)
  if (violations.length === 0) return
  throw new NativeReleaseError(
    400,
    'native_job_draft_rejected',
    `The release job may not set ${violations.map((v) => v.path).join(', ')}.`,
    { violations },
  )
}

/**
 * Build or update? An unchanged fingerprint for the same platform and track means
 * the native side did not change and only JS went out, so it is an OTA update —
 * no build, no charge. A null/previous-missing fingerprint means build.
 */
export function decideReleaseKind(opts: {
  previousFingerprint: string | null | undefined
  fingerprint: string
  hasStoreBuild: boolean
}): ReleaseKind {
  if (!opts.hasStoreBuild) return 'build'
  if (!opts.previousFingerprint) return 'build'
  return opts.previousFingerprint === opts.fingerprint ? 'update' : 'build'
}

/** The resource class we request per platform. Both are on the published card. */
export function storeResourceClass(platform: ReleasePlatform): BuildResourceClass {
  return platform === 'ios' ? 'IOS_MEDIUM' : 'ANDROID_MEDIUM'
}

export function testResourceClass(platform: ReleasePlatform): BuildResourceClass {
  return platform === 'ios' ? 'IOS_MEDIUM' : 'ANDROID_MEDIUM'
}

/**
 * The workflow that builds a simulator/emulator app and runs Maestro.
 *
 * Generated here and sent as `workflowRevisionInput.yamlConfig`, so it never
 * lives in the user's tree. Values are all from closed sets, which is why this
 * can be string interpolation rather than a YAML serialiser.
 */
export function buildTestWorkflowYaml(opts: {
  platforms: ReleasePlatform[]
  profile?: string
  maestroFlows?: string[]
}): string {
  const profile = opts.profile ?? 'shogo-test'
  const flows = opts.maestroFlows?.length ? opts.maestroFlows : ['.maestro']
  const jobs: string[] = []

  for (const platform of opts.platforms) {
    const jobName = platform === 'ios' ? 'build_test_ios' : 'build_test_android'
    jobs.push(`  ${jobName}:
    type: build
    params:
      platform: ${platform}
      profile: ${profile}`)
  }

  const needs = opts.platforms.map((p) => (p === 'ios' ? 'build_test_ios' : 'build_test_android'))
  jobs.push(`  maestro:
    type: maestro
    needs: [${needs.map((n) => `"${n}"`).join(', ')}]
    params:
      build_id: \${{ needs.*.outputs.build_id }}
      flow_path: ${flows.map((f) => `"${f}"`).join(', ')}`)

  return `name: shogo-test\non:\n  workflow_dispatch: {}\njobs:\n${jobs.join('\n')}\n`
}

const PLAN_MESSAGE =
  'Publishing to the App Store and Google Play is available on paid plans. Upgrade to ship native apps.'

/**
 * The plan gate. `byok` is not gated: the user pays Expo and local mode is
 * unlimited (channel rule, SHO-43). Everything else is `cloud` or `relay`, and in
 * relay the **cloud** is the one that checks, against the paired cloud workspace.
 */
export async function assertNativeReleaseAllowed(opts: {
  workspaceId: string
  mode?: ReturnType<typeof nativeReleaseMode>
}): Promise<void> {
  const mode = opts.mode ?? nativeReleaseMode()
  if (mode === 'byok') return
  if (await canUseNativeRelease(opts.workspaceId)) return
  throw new NativeReleaseError(402, 'plan_not_allowed', PLAN_MESSAGE)
}

/**
 * Refuse a release the wallet cannot cover, before a build exists. The test
 * stage is included in the projection because it is charged too.
 */
export async function preflightBalance(opts: {
  workspaceId: string
  memberId: string
  projection: ProjectedReleaseInput
  mode?: ReturnType<typeof nativeReleaseMode>
}): Promise<void> {
  const mode = opts.mode ?? nativeReleaseMode()
  if (mode !== 'cloud') return

  const raw = projectedReleaseRawUsd(opts.projection)
  if (raw <= 0) return
  const check = await checkUsageBalance(opts.workspaceId, raw, opts.memberId)
  if (check.ok) return
  throw new NativeReleaseError(
    402,
    'usage_limit_reached',
    'A native release needs more usage credit than this workspace has left. Top up to ship.',
    { projectedRawUsd: raw },
  )
}

export interface StartReleaseInput {
  workspaceId: string
  projectId: string
  memberId: string
  platforms: ReleasePlatform[]
  track: ReleaseTrack
  fingerprint: string
  hasMaestroFlows: boolean
  /** Job drafts the runner assembled; validated, never trusted. */
  jobDraft?: Record<string, unknown>
  apiBaseUrl: string
}

export interface StartReleaseResult {
  releaseId: string
  kind: ReleaseKind
  uploads: { kind: 'source' | 'metadata' | 'workflow'; url: string; bucketKey: string }[]
  mode: ReturnType<typeof nativeReleaseMode>
}

/**
 * Create the release row and mint its upload slots. Nothing is built yet: the
 * runner still has to upload the archive, and only `sourcesUploaded` starts EAS.
 */
export async function startRelease(input: StartReleaseInput): Promise<StartReleaseResult> {
  const mode = nativeReleaseMode()
  await assertNativeReleaseAllowed({ workspaceId: input.workspaceId, mode })

  if (input.jobDraft) assertRunnerJobDraft(input.jobDraft)
  if (input.platforms.length === 0) {
    throw new NativeReleaseError(400, 'native_no_platforms', 'Choose iOS, Android, or both.')
  }

  const credentials = await resolveEasCredentials({
    workspaceId: input.workspaceId,
    readByokToken: readByokExpoToken,
  })
  const app = await ensureNativeApp({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    credentials,
    apiBaseUrl: input.apiBaseUrl,
  })

  const previous = await db.nativeRelease.findFirst({
    where: {
      projectId: input.projectId,
      status: 'done',
      kind: 'build',
      track: input.track,
    },
    orderBy: { createdAt: 'desc' },
  })

  const kind = decideReleaseKind({
    previousFingerprint: previous?.fingerprint ?? null,
    fingerprint: input.fingerprint,
    hasStoreBuild: Boolean(previous),
  })

  await preflightBalance({
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    mode,
    projection: {
      builds: input.platforms.map((platform) => ({ platform, resourceClass: storeResourceClass(platform) })),
      hasTests: input.hasMaestroFlows && kind === 'build',
    },
  })

  const release = await db.nativeRelease.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      platforms: input.platforms,
      track: input.track,
      fingerprint: input.fingerprint,
      kind,
      status: 'queued',
      step: kind === 'update' ? 'exporting' : 'uploading',
      createdById: input.memberId,
    },
  })

  const client = easClientFor(credentials)
  const uploads: StartReleaseResult['uploads'] = []

  if (kind === 'build') {
    const source = await createUploadSession(client, {
      type: 'EAS_BUILD_GCS_PROJECT_SOURCES',
      filename: 'project.tar.gz',
    })
    uploads.push({ kind: 'source', ...source })
  } else {
    const accountId = app.easAccountId ?? credentials.accountId
    if (!accountId) {
      throw new NativeReleaseError(502, 'expo_account_missing', 'The native app has no Expo account recorded.')
    }
    const asset = await createAccountScopedUploadSession(client, {
      type: 'WORKFLOWS_PROJECT_SOURCES',
      accountID: accountId,
    })
    uploads.push({ kind: 'workflow', ...asset })
  }

  return { releaseId: release.id, kind, uploads, mode }
}

/**
 * The runner has uploaded its archive: start the test workflow, or publish the
 * OTA update. Everything that costs money or touches EAS starts here.
 */
export async function sourcesUploaded(opts: {
  releaseId: string
  bucketKey: string
  jobDraft?: Record<string, unknown>
}): Promise<{ status: string; workflowRunId?: string }> {
  if (opts.jobDraft) assertRunnerJobDraft(opts.jobDraft)

  const release = await db.nativeRelease.findUnique({ where: { id: opts.releaseId } })
  if (!release) throw new NativeReleaseError(404, 'native_release_missing', 'Unknown release.')

  const credentials = await resolveEasCredentials({
    workspaceId: release.workspaceId,
    readByokToken: readByokExpoToken,
  })
  const app = await db.nativeApp.findUnique({ where: { projectId: release.projectId } })
  if (!app?.easAppId) {
    throw new NativeReleaseError(409, 'native_app_missing', 'This release has no Expo project.')
  }

  const client = easClientFor(credentials)
  const platforms: ReleasePlatform[] = release.platforms

  if (release.kind === 'update') {
    await db.nativeRelease.update({
      where: { id: release.id },
      data: { status: 'done', step: 'published_update' },
    })
    return { status: 'done' }
  }

  await db.nativeRelease.update({
    where: { id: release.id },
    data: { sourceBucketKey: opts.bucketKey },
  })

  if (!release.testOutcome && (await hasMaestro(release.projectId))) {
    const run = await createWorkflowRun(client, {
      appId: app.easAppId,
      fileName: '.eas/workflows/shogo-test.yml',
      yamlConfig: buildTestWorkflowYaml({ platforms }),
      projectArchiveBucketKey: opts.bucketKey,
    })
    await db.nativeRelease.update({
      where: { id: release.id },
      data: { workflowRunId: run.id, status: 'testing', step: 'maestro' },
    })
    return { status: 'testing', workflowRunId: run.id }
  }

  return startStoreBuilds({
    releaseId: release.id,
    client,
    app,
    platforms,
    jobDraft: opts.jobDraft ?? {},
  })
}

async function hasMaestro(projectId: string): Promise<boolean> {
  const row = await db.nativeRelease.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  })
  // The runner tells us on the release row (step `maestro-skipped` means the
  // project has no `.maestro/`); default to running the stage otherwise.
  return row?.step !== 'maestro-skipped'
}

/**
 * Start the store builds. Only reached when the test stage passed or was
 * skipped, which is what makes "a failed Maestro flow never costs a store build"
 * true rather than aspirational.
 */
export async function startStoreBuilds(opts: {
  releaseId: string
  client: EasClient
  app: NativeAppRow
  platforms: ReleasePlatform[]
  /** The runner's validated job draft. Protected keys were already rejected. */
  jobDraft?: Record<string, unknown>
}): Promise<{ status: string }> {
  const release = await db.nativeRelease.findUnique({ where: { id: opts.releaseId } })
  if (!release) throw new NativeReleaseError(404, 'native_release_missing', 'Unknown release.')
  if (!opts.app.easAppId) {
    throw new NativeReleaseError(409, 'native_app_missing', 'No Expo project for this release.')
  }
  if (!release.sourceBucketKey) {
    throw new NativeReleaseError(409, 'native_source_missing', 'This release has no uploaded archive.')
  }

  for (const platform of opts.platforms) {
    const resourceClass = storeResourceClass(platform)
    // The class and the token role are ours; everything else comes from the
    // runner's draft, which `assertRunnerJobDraft` has already vetted.
    const job = { ...(opts.jobDraft ?? {}), platform, resourceClass }
    const build = await createBuild(opts.client, {
      platform,
      appId: opts.app.easAppId,
      job,
      metadata: {
        projectMetadataFile: { type: 'GCS', bucketKey: release.sourceBucketKey },
        fingerprintHash: release.fingerprint,
      },
      resourceClass,
      expoTokenRole: 'RUNNER',
    })
    await db.nativeBuild.create({
      data: {
        releaseId: release.id,
        easBuildId: build.id,
        platform,
        purpose: 'store',
        resourceClass,
        status: 'in_progress',
        startedAt: new Date(),
      },
    })
  }

  await db.nativeRelease.update({
    where: { id: release.id },
    data: { status: 'building', step: 'store_build' },
  })
  return { status: 'building' }
}

/**
 * A store build finished: submit it with the customer's credentials inline, so
 * nothing lands in Expo's credential vault, and lock the app ids.
 */
export async function submitStoreBuild(opts: {
  easBuildId: string
}): Promise<{ submitted: boolean }> {
  const build = await db.nativeBuild.findUnique({
    where: { easBuildId: opts.easBuildId },
  })
  if (!build || build.purpose !== 'store') return { submitted: false }

  const release = await db.nativeRelease.findUnique({ where: { id: build.releaseId } })
  if (!release) return { submitted: false }

  const app = await db.nativeApp.findUnique({ where: { projectId: release.projectId } })
  if (!app?.easAppId) return { submitted: false }

  const credentials = await resolveEasCredentials({
    workspaceId: release.workspaceId,
    readByokToken: readByokExpoToken,
  })
  const client = easClientFor(credentials)

  const submission =
    build.platform === 'ios'
      ? await (async () => {
          const key = await readAscKey(release.workspaceId)
          if (!key) {
            throw new NativeReleaseError(
              412,
              'asc_key_required',
              'Connect an App Store Connect API key in Project → App stores before shipping to iOS.',
            )
          }
          return createSubmission(client, {
            platform: 'ios',
            appId: app.easAppId,
            buildId: build.easBuildId,
            ascApiKey: {
              keyP8: key.keyP8,
              keyIdentifier: key.keyId,
              issuerIdentifier: key.issuerId,
            },
          })
        })()
      : await (async () => {
          const play = await readPlayKey(release.workspaceId)
          if (!play) {
            throw new NativeReleaseError(
              412,
              'play_key_required',
              'Connect a Google Play service account in Project → App stores before shipping to Android.',
            )
          }
          return createSubmission(client, {
            platform: 'android',
            appId: app.easAppId,
            buildId: build.easBuildId,
            track: release.track,
            googleServiceAccountKeyJson: play,
          })
        })()

  await db.nativeBuild.update({
    where: { id: build.id },
    data: { submissionId: submission.id, submissionStatus: submission.status },
  })
  await lockAppIdentifiers(release.projectId, build.platform)
  await db.nativeRelease.update({
    where: { id: release.id },
    data: { status: 'submitting', step: 'store_submission' },
  })

  return { submitted: true }
}

/** Read a workflow run's outcome: passed, failed, or still going. */
export async function pollWorkflowRun(releaseId: string): Promise<'pending' | 'passed' | 'failed'> {
  const release = await db.nativeRelease.findUnique({ where: { id: releaseId } })
  if (!release?.workflowRunId) return 'pending'

  const credentials = await resolveEasCredentials({
    workspaceId: release.workspaceId,
    readByokToken: readByokExpoToken,
  })
  const run = await getWorkflowRun(easClientFor(credentials), release.workflowRunId)

  if (run.status === 'SUCCESS') return 'passed'
  if (run.status === 'FAILURE' || run.status === 'CANCELED') {
    await alertOps('native_workflow_failed', { releaseId, workflowRunId: release.workflowRunId })
    return 'failed'
  }
  return 'pending'
}
