// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prints what the plan in `docs/native-release/eas-graphql.md` depends on, straight
 * from the live EAS GraphQL schema, and fails if any of it has moved.
 *
 * Introspection on `https://api.expo.dev/graphql` needs no authentication and mutates
 * nothing, so this is safe to run from anywhere, any time — including a nightly job,
 * because Expo changing a mutation name or an input field is a silent breakage of
 * native release and nothing else in the repo would notice.
 *
 * Usage: bun scripts/native-release-graphql-introspect.ts [--endpoint <url>]
 */

const DEFAULT_ENDPOINT = 'https://api.expo.dev/graphql'

/** Mutations the cloud-side build path calls, as `Parent.child`. */
const REQUIRED_MUTATIONS = [
  'robot.createRobotForAccount',
  'accessToken.createAccessToken',
  'accessToken.setAccessTokenRevoked',
  'app.createApp',
  'webhook.createWebhook',
  'uploadSession.createAppScopedUploadSession',
  'build.createIosBuild',
  'build.createAndroidBuild',
  'workflowRun.createWorkflowRun',
  'submission.createIosSubmission',
  'submission.createAndroidSubmission',
] as const

/** Input fields whose absence means the archive-based path is gone. */
const REQUIRED_INPUT_FIELDS: Record<string, string[]> = {
  BuildMetadataInput: ['projectMetadataFile', 'appVersion', 'appBuildVersion', 'runtimeVersion'],
  ProjectMetadataFileInput: ['type', 'bucketKey'],
  WorkflowProjectSourceInput: ['type', 'projectArchiveBucketKey', 'easJsonBucketKey', 'packageJsonBucketKey'],
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

function typeName(ref: TypeRef | undefined | null): string {
  let cur = ref
  while (cur) {
    if (cur.name) return cur.name
    cur = cur.ofType
  }
  return '?'
}

const TYPE_QUERY = `{ __type(name: "%s") { name kind
  fields { name args { name type { kind name ofType { kind name } } } type { kind name ofType { kind name } } }
  inputFields { name type { kind name ofType { kind name } } }
  enumValues { name } } }`

async function fetchType(name: string): Promise<GqlType | null> {
  const data = await gql<{ __type: GqlType | null }>(TYPE_QUERY.replace('%s', name))
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

const byParent = new Map<string, string[]>()
for (const key of REQUIRED_MUTATIONS) {
  const [parent, child] = key.split('.')
  if (!rootNames.has(parent)) {
    problems.push(`root mutation "${parent}" is gone (${key})`)
    continue
  }
  byParent.set(parent, [...(byParent.get(parent) ?? []), child])
}

for (const [parent, children] of byParent) {
  const type = await fetchType(namespaceTypes.get(parent) ?? '')
  if (!type?.fields) {
    problems.push(`mutation type "${parent}" has no fields`)
    continue
  }
  const present = new Set(type.fields.map((f) => f.name))
  for (const child of children) {
    if (!present.has(child)) problems.push(`${parent}.${child} is gone`)
  }
}

for (const [typeNameWanted, fields] of Object.entries(REQUIRED_INPUT_FIELDS)) {
  const type = await fetchType(typeNameWanted)
  if (!type) {
    problems.push(`input type "${typeNameWanted}" is gone`)
    continue
  }
  const present = new Set((type.inputFields ?? []).map((f) => f.name))
  for (const field of fields) {
    if (!present.has(field)) problems.push(`${typeNameWanted}.${field} is gone`)
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
const permissions = (permission?.enumValues ?? []).map((v) => v.name).join(' | ')
const webhookType = await fetchType('WebhookType')
const webhookEvents = (webhookType?.enumValues ?? []).map((v) => v.name).join(' | ')

console.log(`EAS GraphQL: ${endpoint}`)
console.log(`  mutations checked : ${REQUIRED_MUTATIONS.length}`)
console.log(`  Permission        : ${permissions}`)
console.log(`  WebhookType       : ${webhookEvents}`)

if (problems.length > 0) {
  console.error('\nSchema moved out from under docs/native-release/eas-graphql.md:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('\nOK — every mutation and input the native-release plan uses is present.')
