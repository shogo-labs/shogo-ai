// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed wrappers for the EAS GraphQL calls a release makes.
 *
 * Everything here was read from the live schema
 * (`scripts/native-release-graphql-introspect.ts` re-checks it, and fails CI if a
 * name, argument type or enum value moves). The two calls that look plausible and
 * are wrong are documented in `docs/native-release/eas-graphql.md`: project
 * sources are **not** app-scoped (`createUploadSession`, not
 * `createAppScopedUploadSession`, whose only type is `PROFILE_IMAGE_UPLOAD`), and
 * `resourceClass` is `BuildResourceClass` (`IOS_MEDIUM`), not `MEDIUM`.
 *
 * These functions take an `EasClient` rather than resolving one, so a test can
 * hand them a fake and a route can hand them the token it already resolved.
 */

import { NativeReleaseError, type EasClient } from './client'

/**
 * Every GraphQL document this module sends, in one place so a test can validate
 * the **documents themselves** against the schema snapshot.
 *
 * That test is not a formality: a fake `client.request` accepts any string, so
 * six of these once shipped with a selection on `JSONObject!`, a `JobInput` that
 * does not exist and singular root fields, and every unit test still passed
 * while the first call of every release 400d. Keep the documents here, not
 * inline in the functions.
 */
export const DOCUMENTS: Record<string, string> = {
  meActor: `query { meActor { __typename id ... on User { accounts { id name } } ... on Robot { accounts { id name } } } }`,

  createApp: `mutation CreateApp($appInput: AppInput!) {
    app { createApp(appInput: $appInput) { id slug } }
  }`,

  createWebhook: `mutation CreateWebhook($appId: String!, $webhookInput: WebhookInput!) {
    webhook { createWebhook(appId: $appId, webhookInput: $webhookInput) { id } }
  }`,

  // Returns `JSONObject!`: the selection is the bare field and the payload is
  // read off the object. `{ url bucketKey }` here is a hard 400.
  createUploadSession: `mutation CreateUploadSession($type: UploadSessionType!, $filename: String) {
    uploadSession { createUploadSession(type: $type, filename: $filename) }
  }`,

  createAccountScopedUploadSession: `mutation CreateAccountScopedUploadSession($type: AccountUploadSessionType!, $accountID: ID!) {
    uploadSession { createAccountScopedUploadSession(type: $type, accountID: $accountID) }
  }`,

  // `job` is typed per platform; there is no shared `JobInput`. The result wraps
  // the build: `CreateBuildResult { build }`.
  createIosBuild: `mutation CreateIosBuild($appId: ID!, $job: IosJobInput!, $metadata: BuildMetadataInput, $buildParams: BuildParamsInput) {
    build { createIosBuild(appId: $appId, job: $job, metadata: $metadata, buildParams: $buildParams) { build { id status } } }
  }`,

  createAndroidBuild: `mutation CreateAndroidBuild($appId: ID!, $job: AndroidJobInput!, $metadata: BuildMetadataInput, $buildParams: BuildParamsInput) {
    build { createAndroidBuild(appId: $appId, job: $job, metadata: $metadata, buildParams: $buildParams) { build { id status } } }
  }`,

  createWorkflowRun: `mutation CreateWorkflowRun($appId: ID!, $workflowRevisionInput: WorkflowRevisionInput!, $workflowRunInput: WorkflowRunInput!) {
    workflowRun { createWorkflowRun(appId: $appId, workflowRevisionInput: $workflowRevisionInput, workflowRunInput: $workflowRunInput) { id status } }
  }`,

  // The root fields are plural (`workflowRuns`, `builds`, `submissions`).
  // `jobs.turtleBuild` is how the poller learns which builds the test stage
  // actually ran — the webhook cannot, because a workflow build has no
  // `NativeBuild` row when it starts and we must not guess at a charge.
  getWorkflowRun: `query GetWorkflowRun($workflowRunId: ID!) {
    workflowRuns { byId(workflowRunId: $workflowRunId) { id status durationSeconds jobs { key name type status turtleBuild { id status platform } } } }
  }`,

  getBuild: `query GetBuild($buildId: ID!) {
    builds { byId(buildId: $buildId) { id status } }
  }`,

  // No `SubmissionInput`: the two platforms have their own input type, each with
  // a required nested config.
  createIosSubmission: `mutation CreateIosSubmission($input: CreateIosSubmissionInput!) {
    submission { createIosSubmission(input: $input) { submission { id status } } }
  }`,

  createAndroidSubmission: `mutation CreateAndroidSubmission($input: CreateAndroidSubmissionInput!) {
    submission { createAndroidSubmission(input: $input) { submission { id status } } }
  }`,
}

export type BuildResourceClass =
  | 'ANDROID_DEFAULT'
  | 'ANDROID_MEDIUM'
  | 'ANDROID_LARGE'
  | 'IOS_DEFAULT'
  | 'IOS_MEDIUM'
  | 'IOS_LARGE'
  | 'IOS_M_MEDIUM'
  | 'IOS_M_LARGE'
  | 'LEGACY'
  | 'LINUX_MEDIUM'
  | 'LINUX_LARGE'

export type UploadSessionKind =
  | 'EAS_BUILD_GCS_PROJECT_SOURCES'
  | 'EAS_BUILD_GCS_PROJECT_METADATA'
  | 'EAS_SUBMIT_GCS_APP_ARCHIVE'

export type AccountUploadSessionKind = 'WORKFLOWS_PROJECT_SOURCES'

export type WorkflowRunStatus =
  | 'NEW'
  | 'WAITING'
  | 'IN_PROGRESS'
  | 'ACTION_REQUIRED'
  | 'SUCCESS'
  | 'FAILURE'
  | 'CANCELED'

export interface UploadSlot {
  url: string
  bucketKey: string
}

export interface EasAccount {
  id: string
  name: string
}

function pick<T>(data: Record<string, any>, path: string[]): T {
  let cur: any = data
  for (const key of path) {
    cur = cur?.[key]
  }
  if (cur === undefined || cur === null) {
    throw new NativeReleaseError(502, 'eas_unexpected_shape', `Expo response is missing ${path.join('.')}`)
  }
  return cur as T
}

/** The accounts this token can act for. Used by BYOK to find `accountId`. */
export async function meActor(client: EasClient): Promise<{ id: string; accounts: EasAccount[] }> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.meActor)
  const actor = pick<any>(data, ['meActor'])
  return { id: String(actor.id), accounts: (actor.accounts ?? []).map((a: any) => ({ id: a.id, name: a.name })) }
}

/**
 * Create the EAS project for a Shogo project. Idempotency lives in
 * `apps.service.ensureNativeApp` (the row is the lock), not here: Expo has no
 * "create or return existing" mutation.
 */
export async function createApp(
  client: EasClient,
  input: { accountId: string; projectName: string },
): Promise<{ id: string; slug: string }> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.createApp, {
    appInput: { accountId: input.accountId, projectName: input.projectName },
  })
  const app = pick<any>(data, ['app', 'createApp'])
  return { id: String(app.id), slug: String(app.slug) }
}

export async function createWebhook(
  client: EasClient,
  input: { appId: string; url: string; secret: string; event: 'BUILD' | 'SUBMIT' },
): Promise<{ id: string }> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.createWebhook, {
    appId: input.appId,
    webhookInput: { url: input.url, secret: input.secret, event: input.event },
  })
  return { id: String(pick<any>(data, ['webhook', 'createWebhook', 'id'])) }
}

/** A signed slot for a build's source archive or its metadata. Not app-scoped. */
export async function createUploadSession(
  client: EasClient,
  input: { type: UploadSessionKind; filename: string },
): Promise<UploadSlot> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.createUploadSession, input)
  // `createUploadSession` returns `JSONObject!`, which has no subfields: the
  // selection must be the bare field and `url`/`bucketKey` are read off the
  // returned object. Selecting `{ url bucketKey }` is a hard 400 from the API.
  const slot = pick<any>(data, ['uploadSession', 'createUploadSession'])
  return { url: String(slot.url), bucketKey: String(slot.bucketKey) }
}

/** A signed slot for a workflow's project source. Account-scoped, not app-scoped. */
export async function createAccountScopedUploadSession(
  client: EasClient,
  input: { type: AccountUploadSessionKind; accountID: string },
): Promise<UploadSlot> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.createAccountScopedUploadSession, input)
  const slot = pick<any>(data, ['uploadSession', 'createAccountScopedUploadSession'])
  return { url: String(slot.url), bucketKey: String(slot.bucketKey) }
}

/**
 * `projectMetadataFile` is deliberately absent. Every `BuildMetadataInput`
 * field is optional, and this file is the JSON EAS parses for the project's
 * config — a *separate* upload from the source archive (`UploadSessionType`
 * has `EAS_BUILD_GCS_PROJECT_METADATA` for it). We open no such upload slot, so
 * the only way to fill the field was to reuse the source archive's bucketKey,
 * which points EAS at a tarball where it expects JSON. Omit it and let EAS read
 * the project from the archive; `fingerprintHash` is what we actually know.
 */
export interface BuildMetadata {
  appIdentifier?: string
  appVersion?: string
  appBuildVersion?: string
  runtimeVersion?: string
  fingerprintHash?: string
  sdkVersion?: string
}

/**
 * Start a store build. The job carries the signing credentials, so nothing is
 * stored in Expo's credential vault on our account; `expoTokenRole` is always
 * RUNNER and `resourceClass` is always one the meter can price.
 */
export async function createBuild(
  client: EasClient,
  input: {
    platform: 'ios' | 'android'
    appId: string
    job: Record<string, unknown>
    metadata: BuildMetadata
    resourceClass: BuildResourceClass
    expoTokenRole?: string
  },
): Promise<{ id: string; status: string }> {
  // `job` is typed per platform (`IosJobInput!` / `AndroidJobInput!`); there is
  // no shared `JobInput`. The result wraps the build: `CreateBuildResult { build }`.
  const field = input.platform === 'ios' ? 'createIosBuild' : 'createAndroidBuild'
  const document = input.platform === 'ios' ? DOCUMENTS.createIosBuild : DOCUMENTS.createAndroidBuild
  const data = await client.request<Record<string, any>>(document, {
    appId: input.appId,
    job: input.job,
    metadata: input.metadata,
    buildParams: {
      resourceClass: input.resourceClass,
      expoTokenRole: input.expoTokenRole ?? 'RUNNER',
    },
  })
  return pick<{ id: string; status: string }>(data, ['build', field, 'build'])
}

/**
 * Run the generated test workflow (simulator/emulator build + Maestro) from an
 * uploaded archive. `WorkflowProjectSourceInput` accepts bucket keys, so this
 * needs no git remote — the project is local-first.
 */
export async function createWorkflowRun(
  client: EasClient,
  input: {
    appId: string
    fileName: string
    yamlConfig: string
    projectArchiveBucketKey: string
    easJsonBucketKey?: string
    packageJsonBucketKey?: string
  },
): Promise<{ id: string; status: WorkflowRunStatus }> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.createWorkflowRun, {
      appId: input.appId,
      workflowRevisionInput: { fileName: input.fileName, yamlConfig: input.yamlConfig },
      workflowRunInput: {
        projectSource: {
          type: 'GCS',
          projectArchiveBucketKey: input.projectArchiveBucketKey,
          easJsonBucketKey: input.easJsonBucketKey,
          packageJsonBucketKey: input.packageJsonBucketKey,
        },
      },
    },
  )
  return pick<{ id: string; status: WorkflowRunStatus }>(data, ['workflowRun', 'createWorkflowRun'])
}

/** Poll a workflow run. `WebhookType` is only BUILD | SUBMIT, so this is how a
 * test run's result is learned (and the only way BYOK learns anything). */
export async function getWorkflowRun(
  client: EasClient,
  workflowRunId: string,
): Promise<{
  id: string
  status: WorkflowRunStatus
  durationSeconds?: number | null
  jobs?: {
    key?: string
    name?: string
    type?: string
    status?: string
    turtleBuild?: { id?: string; status?: string; platform?: string } | null
  }[]
}> {
  // The root field is plural (`workflowRuns { byId }`); `workflowRun` does not exist.
  const data = await client.request<Record<string, any>>(DOCUMENTS.getWorkflowRun, { workflowRunId })
  return pick<any>(data, ['workflowRuns', 'byId'])
}

export interface AscApiKeyInline {
  keyP8: string
  keyIdentifier: string
  issuerIdentifier: string
}

export interface AndroidSubmissionCredential {
  googleServiceAccountKeyJson: string
}

/**
 * Submit an already-built binary, with the credentials inline.
 *
 * Inline keeps the customer's Apple key out of Expo's credential storage: it
 * exists for the duration of this submission input and nowhere else.
 *
 * The two platforms take **different** input types with a **required** nested
 * config (there is no `SubmissionInput`): iOS needs `ascAppIdentifier` and
 * `groups`, Android needs `track` — leaving any of them out is a validation
 * error from the API, not a default.
 */
export async function createSubmission(
  client: EasClient,
  input: {
    platform: 'ios' | 'android'
    appId: string
    buildId: string
    /** `internal` | `alpha` | `beta` | `production` (Android only). */
    track?: string
    /** App Store Connect app id (or bundle id). Required by the iOS input. */
    ascAppIdentifier?: string
    /** TestFlight group names, comma-separated. Empty means the app's default. */
    groups?: string
    ascApiKey?: AscApiKeyInline
    googleServiceAccountKeyJson?: string
    /** Play application id; defaults to the app's package name. */
    applicationIdentifier?: string
  },
): Promise<{ id: string; status: string }> {
  if (input.platform === 'ios') {
    if (!input.ascAppIdentifier) {
      throw new NativeReleaseError(
        409,
        'native_asc_app_missing',
        'Submitting to the App Store needs the App Store Connect app id.',
      )
    }
    const data = await client.request<Record<string, any>>(DOCUMENTS.createIosSubmission, {
      input: {
        appId: input.appId,
        submittedBuildId: input.buildId,
        config: {
          // `ascApiKey` is the inline key; `ascApiKeyId` is the alternative for a
          // key already stored on the account, which we deliberately do not use.
          ...(input.ascApiKey ? { ascApiKey: input.ascApiKey } : {}),
          ascAppIdentifier: input.ascAppIdentifier,
          groups: input.groups ?? '',
        },
      },
    })
    return pick<{ id: string; status: string }>(data, ['submission', 'createIosSubmission', 'submission'])
  }

  const track = input.track ?? 'internal'
  const data = await client.request<Record<string, any>>(DOCUMENTS.createAndroidSubmission, {
    input: {
      appId: input.appId,
      submittedBuildId: input.buildId,
      config: {
        ...(input.googleServiceAccountKeyJson
          ? { googleServiceAccountKeyJson: input.googleServiceAccountKeyJson }
          : {}),
        ...(input.applicationIdentifier ? { applicationIdentifier: input.applicationIdentifier } : {}),
        track,
      },
    },
  })
  return pick<{ id: string; status: string }>(data, ['submission', 'createAndroidSubmission', 'submission'])
}

export async function getBuild(
  client: EasClient,
  buildId: string,
): Promise<{ id: string; status: string; resourceClass?: BuildResourceClass }> {
  const data = await client.request<Record<string, any>>(DOCUMENTS.getBuild, { buildId })
  return pick<any>(data, ['builds', 'byId'])
}
