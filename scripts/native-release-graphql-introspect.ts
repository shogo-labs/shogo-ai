// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prints what the plan in `docs/native-release/eas-graphql.md` depends on, straight
 * from the live EAS GraphQL schema, and fails if any of it has moved.
 *
 * Introspection on `https://api.expo.dev/graphql` needs no authentication and mutates
 * nothing, so this is safe to run from anywhere, any time — including a nightly job,
 * because Expo changing a mutation name, an argument's type or an enum value is a
 * silent breakage of native release and nothing else in the repo would notice.
 *
 * It asserts **types, not just names**. Checking that
 * `uploadSession.createAppScopedUploadSession` exists passes happily while its only
 * permitted `type` is `PROFILE_IMAGE_UPLOAD` and it cannot upload a project archive at
 * all; checking that `build.createIosBuild` exists passes while
 * `BuildParamsInput.resourceClass` silently changes enum and every build is priced
 * against the wrong row. Both arguments and enum values are therefore part of the
 * contract below.
 *
 * Usage: bun scripts/native-release-graphql-introspect.ts [--endpoint <url>]
 */

const DEFAULT_ENDPOINT = 'https://api.expo.dev/graphql'

/**
 * Mutations the cloud-side build path calls, as `Parent.child`, with the type each
 * argument must have. An argument typed as an enum is checked value-by-value through
 * `REQUIRED_ENUM_VALUES` as well.
 */
const REQUIRED_MUTATIONS: Record<string, Record<string, string>> = {
  'robot.createRobotForAccount': {
    accountID: 'String',
    robotData: 'RobotDataInput',
    permissions: 'Permission',
  },
  'accessToken.createAccessToken': { createAccessTokenData: 'CreateAccessTokenInput' },
  'accessToken.setAccessTokenRevoked': { id: 'ID', revoked: 'Boolean' },
  'app.createApp': { appInput: 'AppInput' },
  'webhook.createWebhook': { appId: 'String', webhookInput: 'WebhookInput' },
  // Unscoped: project source uploads carry no app id.
  'uploadSession.createUploadSession': { type: 'UploadSessionType', filename: 'String' },
  // Account-scoped: this is the only route to a workflow project source.
  'uploadSession.createAccountScopedUploadSession': { type: 'AccountUploadSessionType', accountID: 'ID' },
  'build.createIosBuild': {
    appId: 'ID',
    job: 'IosJobInput',
    metadata: 'BuildMetadataInput',
    buildParams: 'BuildParamsInput',
  },
  'build.createAndroidBuild': {
    appId: 'ID',
    job: 'AndroidJobInput',
    metadata: 'BuildMetadataInput',
    buildParams: 'BuildParamsInput',
  },
  'workflowRun.createWorkflowRun': {
    appId: 'ID',
    workflowRevisionInput: 'WorkflowRevisionInput',
    workflowRunInput: 'WorkflowRunInput',
  },
  'submission.createIosSubmission': { input: 'CreateIosSubmissionInput' },
  'submission.createAndroidSubmission': { input: 'CreateAndroidSubmissionInput' },
}

/** Input fields (and their types) whose absence means the archive path is gone. */
const REQUIRED_INPUT_FIELDS: Record<string, Record<string, string>> = {
  BuildParamsInput: { resourceClass: 'BuildResourceClass', expoTokenRole: 'JobExpoTokenRole' },
  BuildMetadataInput: {
    projectMetadataFile: 'ProjectMetadataFileInput',
    appVersion: 'String',
    appBuildVersion: 'String',
    runtimeVersion: 'String',
    fingerprintHash: 'String',
  },
  ProjectMetadataFileInput: { type: 'ProjectArchiveSourceType', bucketKey: 'String' },
  WorkflowProjectSourceInput: {
    type: 'WorkflowProjectSourceType',
    projectArchiveBucketKey: 'String',
    easJsonBucketKey: 'String',
    packageJsonBucketKey: 'String',
  },
}

/** Enum values the doc relies on. A missing value breaks a call the plan makes. */
const REQUIRED_ENUM_VALUES: Record<string, string[]> = {
  // `uploadSession.createUploadSession(type:)` — project sources, not profile images.
  UploadSessionType: [
    'EAS_BUILD_GCS_PROJECT_SOURCES',
    'EAS_BUILD_GCS_PROJECT_METADATA',
    'EAS_SUBMIT_GCS_APP_ARCHIVE',
  ],
  // `uploadSession.createAccountScopedUploadSession(type:)` — the workflow source.
  AccountUploadSessionType: ['WORKFLOWS_PROJECT_SOURCES'],
  // Every class the webhook can report, so the meter's price table has a row for each.
  BuildResourceClass: [
    'ANDROID_MEDIUM',
    'ANDROID_LARGE',
    'IOS_MEDIUM',
    'IOS_LARGE',
    'IOS_M_MEDIUM',
    'IOS_M_LARGE',
  ],
  Permission: ['PUBLISH'],
  WebhookType: ['BUILD', 'SUBMIT'],
}

/**
 * Values whose arrival invalidates a documented decision — these must stay absent, and
 * the failure tells whoever reads it which paragraph to re-read.
 */
const FORBIDDEN_ENUM_VALUES: Record<string, string[]> = {
  // `createAppScopedUploadSession` is app-scoped but can only upload a profile image;
  // if Expo ever lets it take project sources, re-check which route the plan should use.
  AppUploadSessionType: ['EAS_BUILD_GCS_PROJECT_SOURCES', 'WORKFLOWS_PROJECT_SOURCES'],
}

/** The absence of this is the finding that forced the architecture, so assert it too. */
const FORBIDDEN_ROOT_MUTATIONS = ['organization', 'createOrganization', 'account.createOrganization']

interface TypeRef {
  kind: string
  name: string | null
  ofType?: TypeRef | null
}

interface Field {
  name: string
  args: { name: string; type: TypeRef }[]
  type: TypeRef
}

interface GqlType {
  name: string
  kind: string
  fields?: Field[] | null
  inputFields?: { name: string; type: TypeRef }[] | null
  enumValues?: { name: string }[] | null
}

const endpoint = (() => {
  const i = process.argv.indexOf('--endpoint')
  return i === -1 ? DEFAULT_ENDPOINT : process.argv[i + 1]
})()

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (!res.ok || body.errors?.length) {
    throw new Error(`EAS GraphQL ${res.status}: ${body.errors?.map((e) => e.message).join('; ') ?? 'no data'}`)
  }
  return body.data as T
}

/** The name under any `NON_NULL` / `LIST` wrapper — `[BuildResourceClass!]!` -> `BuildResourceClass`. */
function typeName(ref: TypeRef | undefined | null): string {
  let cur = ref
  while (cur) {
    if (cur.name) return cur.name
    cur = cur.ofType
  }
  return '?'
}

const TYPE_QUERY = `{ __type(name: "%s") { name kind
  fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name } } }
  inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
  enumValues { name } } }`

const typeCache = new Map<string, GqlType | null>()

async function fetchType(name: string): Promise<GqlType | null> {
  if (typeCache.has(name)) return typeCache.get(name) ?? null
  const data = await gql<{ __type: GqlType | null }>(TYPE_QUERY.replace('%s', name))
  typeCache.set(name, data.__type)
  return data.__type
}

const problems: string[] = []

const root = await gql<{ __schema: { mutationType: { fields: Field[] } } }>(
  '{ __schema { mutationType { fields { name type { kind name ofType { kind name } } } } } }',
)
const rootNames = new Set(root.__schema.mutationType.fields.map((f) => f.name))
/**
 * The namespace type a root mutation returns. It is usually `<name>Mutation` but not
 * always (`uploadSession` returns `UploadSession`), so read it instead of guessing.
 */
const namespaceTypes = new Map(
  root.__schema.mutationType.fields.map((f) => [f.name, typeName(f.type)] as const),
)

const byParent = new Map<string, { child: string; args: Record<string, string> }[]>()
for (const [path, args] of Object.entries(REQUIRED_MUTATIONS)) {
  const [parent, child] = path.split('.')
  if (!rootNames.has(parent)) {
    problems.push(`root mutation "${parent}" is gone (${path})`)
    continue
  }
  byParent.set(parent, [...(byParent.get(parent) ?? []), { child, args }])
}

for (const [parent, children] of byParent) {
  const namespaceTypeName = namespaceTypes.get(parent)
  const type = await fetchType(namespaceTypeName ?? '')
  if (!type?.fields) {
    problems.push(`mutation type "${namespaceTypeName ?? parent}" has no fields`)
    continue
  }
  for (const { child, args } of children) {
    const field = type.fields.find((f) => f.name === child)
    if (!field) {
      problems.push(`${parent}.${child} is gone`)
      continue
    }
    for (const [argName, expected] of Object.entries(args)) {
      const arg = field.args.find((a) => a.name === argName)
      if (!arg) {
        problems.push(`${parent}.${child} no longer takes "${argName}" (expected ${expected})`)
        continue
      }
      const actual = typeName(arg.type)
      if (actual !== expected) {
        problems.push(`${parent}.${child}(${argName}:) is ${actual}, this file and the doc say ${expected}`)
      }
    }
  }
}

for (const [typeNameWanted, fields] of Object.entries(REQUIRED_INPUT_FIELDS)) {
  const type = await fetchType(typeNameWanted)
  if (!type) {
    problems.push(`input type "${typeNameWanted}" is gone`)
    continue
  }
  const present = new Map((type.inputFields ?? []).map((f) => [f.name, typeName(f.type)] as const))
  for (const [fieldName, expected] of Object.entries(fields)) {
    if (!present.has(fieldName)) {
      problems.push(`${typeNameWanted}.${fieldName} is gone`)
      continue
    }
    const actual = present.get(fieldName)
    if (actual !== expected) {
      problems.push(`${typeNameWanted}.${fieldName} is ${actual}, this file and the doc say ${expected}`)
    }
  }
}

for (const [enumTypeName, required] of Object.entries(REQUIRED_ENUM_VALUES)) {
  const type = await fetchType(enumTypeName)
  if (!type?.enumValues) {
    problems.push(`enum "${enumTypeName}" is gone`)
    continue
  }
  const values = new Set(type.enumValues.map((v) => v.name))
  for (const value of required) {
    if (!values.has(value)) problems.push(`${enumTypeName}.${value} is gone`)
  }
}

for (const [enumTypeName, forbidden] of Object.entries(FORBIDDEN_ENUM_VALUES)) {
  const type = await fetchType(enumTypeName)
  if (!type?.enumValues) continue
  const values = new Set(type.enumValues.map((v) => v.name))
  for (const value of forbidden) {
    if (values.has(value)) problems.push(`${enumTypeName}.${value} now exists — re-read docs/native-release/eas-graphql.md`)
  }
}

for (const forbidden of FORBIDDEN_ROOT_MUTATIONS) {
  const [parent, child] = forbidden.split('.')
  if (!child) {
    if (rootNames.has(parent)) problems.push(`${parent} now exists — re-read the tenancy design`)
    continue
  }
  if (!rootNames.has(parent)) continue
  const type = await fetchType(namespaceTypes.get(parent) ?? '')
  if (type?.fields?.some((f) => f.name === child)) {
    problems.push(`${forbidden} now exists — re-read the tenancy design`)
  }
}

const permission = await fetchType('Permission')
const resourceClass = await fetchType('BuildResourceClass')
const uploadTypes = await fetchType('UploadSessionType')
const appUploadTypes = await fetchType('AppUploadSessionType')
const names = (t: GqlType | null) => (t?.enumValues ?? []).map((v) => v.name).join(' | ')

console.log(`EAS GraphQL: ${endpoint}`)
console.log(`  mutations checked  : ${Object.keys(REQUIRED_MUTATIONS).length}`)
console.log(`  Permission         : ${names(permission)}`)
console.log(`  UploadSessionType  : ${names(uploadTypes)}`)
console.log(`  AppUploadSessionType: ${names(appUploadTypes)}`)
console.log(`  BuildResourceClass : ${names(resourceClass)}`)

if (problems.length > 0) {
  console.error('\nSchema moved out from under docs/native-release/eas-graphql.md:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('\nOK — every mutation, argument type and enum value the native-release plan uses is present.')
