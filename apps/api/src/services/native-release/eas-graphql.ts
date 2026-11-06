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
  const data = await client.request<Record<string, any>>(
    `query { meActor { __typename id ... on User { accounts { id name } } ... on Robot { accounts { id name } } } }`,
  )
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
  const data = await client.request<Record<string, any>>(
    `mutation CreateApp($appInput: AppInput!) { app { createApp(appInput: $appInput) { id slug } } }`,
    { appInput: { accountId: input.accountId, projectName: input.projectName } },
  )
  const app = pick<any>(data, ['app', 'createApp'])
  return { id: String(app.id), slug: String(app.slug) }
}

export async function createWebhook(
  client: EasClient,
  input: { appId: string; url: string; secret: string; event: 'BUILD' | 'SUBMIT' },
): Promise<{ id: string }> {
  const data = await client.request<Record<string, any>>(
    `mutation CreateWebhook($appId: String!, $webhookInput: WebhookInput!) {
       webhook { createWebhook(appId: $appId, webhookInput: $webhookInput) { id } }
     }`,
    { appId: input.appId, webhookInput: { url: input.url, secret: input.secret, event: input.event } },
  )
  return { id: String(pick<any>(data, ['webhook', 'createWebhook', 'id'])) }
}

/** A signed slot for a build's source archive or its metadata. Not app-scoped. */
export async function createUploadSession(
  client: EasClient,
  input: { type: UploadSessionKind; filename: string },
): Promise<UploadSlot> {
  const data = await client.request<Record<string, any>>(
    `mutation CreateUploadSession($type: UploadSessionType!, $filename: String!) {
       uploadSession { createUploadSession(type: $type, filename: $filename) { url bucketKey } }
     }`,
    input,
  )
  return pick<UploadSlot>(data, ['uploadSession', 'createUploadSession'])
}

/** A signed slot for a workflow's project source. Account-scoped, not app-scoped. */
export async function createAccountScopedUploadSession(
  client: EasClient,
  input: { type: AccountUploadSessionKind; accountID: string },
): Promise<UploadSlot> {
  const data = await client.request<Record<string, any>>(
    `mutation CreateAccountScopedUploadSession($type: AccountUploadSessionType!, $accountID: ID!) {
       uploadSession { createAccountScopedUploadSession(type: $type, accountID: $accountID) { url bucketKey } }
     }`,
    input,
  )
  return pick<UploadSlot>(data, ['uploadSession', 'createAccountScopedUploadSession'])
}

export interface BuildMetadata {
  projectMetadataFile: { type: 'GCS'; bucketKey: string }
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
  const field = input.platform === 'ios' ? 'createIosBuild' : 'createAndroidBuild'
  const data = await client.request<Record<string, any>>(
    `mutation CreateBuild($appId: ID!, $job: JobInput!, $metadata: BuildMetadataInput!, $buildParams: BuildParamsInput!) {
       build { ${field}(appId: $appId, job: $job, metadata: $metadata, buildParams: $buildParams) { id status } }
     }`,
    {
      appId: input.appId,
      job: input.job,
      metadata: input.metadata,
      buildParams: {
        resourceClass: input.resourceClass,
        expoTokenRole: input.expoTokenRole ?? 'RUNNER',
      },
    },
  )
  return pick<{ id: string; status: string }>(data, ['build', field])
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
  const data = await client.request<Record<string, any>>(
    `mutation CreateWorkflowRun($appId: ID!, $workflowRevisionInput: WorkflowRevisionInput!, $workflowRunInput: WorkflowRunInput!) {
       workflowRun { createWorkflowRun(appId: $appId, workflowRevisionInput: $workflowRevisionInput, workflowRunInput: $workflowRunInput) { id status } }
     }`,
    {
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
): Promise<{ id: string; status: WorkflowRunStatus; jobs?: { name: string; status: string }[] }> {
  const data = await client.request<Record<string, any>>(
    `query GetWorkflowRun($workflowRunId: ID!) {
       workflowRun { byId(workflowRunId: $workflowRunId) { id status jobs { name status } } }
     }`,
    { workflowRunId },
  )
  return pick<any>(data, ['workflowRun', 'byId'])
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
 * Submit an already-built binary, with the API key inline. Inline keeps the
 * customer's Apple key out of Expo's credential storage: it exists for the
 * duration of this submission input and nowhere else.
 */
export async function createSubmission(
  client: EasClient,
  input: {
    platform: 'ios' | 'android'
    appId: string
    buildId: string
    track?: string
    ascApiKey?: AscApiKeyInline
    googleServiceAccountKeyJson?: string
  },
): Promise<{ id: string; status: string }> {
  const field = input.platform === 'ios' ? 'createIosSubmission' : 'createAndroidSubmission'
  const submissionInput: Record<string, unknown> = {
    appId: input.appId,
    buildId: input.buildId,
    ...(input.track ? { track: input.track } : {}),
    ...(input.ascApiKey ? { ascApiKey: input.ascApiKey } : {}),
    ...(input.googleServiceAccountKeyJson
      ? { googleServiceAccountKeyJson: input.googleServiceAccountKeyJson }
      : {}),
  }
  const data = await client.request<Record<string, any>>(
    `mutation CreateSubmission($input: SubmissionInput!) {
       submission { ${field}(input: $input) { id status } }
     }`,
    { input: submissionInput },
  )
  return pick<{ id: string; status: string }>(data, ['submission', field])
}

export async function getBuild(
  client: EasClient,
  buildId: string,
): Promise<{ id: string; status: string; resourceClass?: BuildResourceClass }> {
  const data = await client.request<Record<string, any>>(
    `query GetBuild($buildId: ID!) { build { byId(buildId: $buildId) { id status } } }`,
    { buildId },
  )
  return pick<any>(data, ['build', 'byId'])
}
