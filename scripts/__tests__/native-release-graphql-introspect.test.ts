// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The introspection guard behind `docs/native-release/eas-graphql.md` is only worth
 * having if it catches the defects the doc already shipped once: a mutation whose name
 * is right but whose `type` argument cannot express what the plan does with it, and a
 * resource-class enum that does not match the price table. Both passed a
 * name-and-field check, so these tests serve a frozen copy of the real schema from a
 * local stub and assert the guard fails — and says why — when either moves.
 *
 * The fixture is a snapshot, never fetched at test time: the test asserts the checker's
 * logic, and `bun scripts/native-release-graphql-introspect.ts` asserts the live schema.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../scripts/native-release-graphql-introspect.ts')

type Schema = {
  root: { __schema: { mutationType: { fields: { name: string; type: unknown }[] } } }
  types: Record<string, Record<string, unknown>>
}

const snapshot = (): Schema =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/eas-graphql-schema.json'), 'utf8')) as Schema

/** Answers the exact three query shapes the checker issues, from a fixture. */
function serve(schema: Schema) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const { query } = (await req.json()) as { query: string }
      if (query.includes('__schema')) {
        return Response.json({ data: schema.root })
      }
      const name = /__type\(name: "([^"]+)"\)/.exec(query)?.[1] ?? ''
      return Response.json({ data: { __type: schema.types[name] ?? null } })
    },
  })
}

async function runChecker(schema: Schema) {
  const server = serve(schema)
  try {
    const proc = Bun.spawn(
      ['bun', SCRIPT, '--endpoint', `http://127.0.0.1:${server.port}/graphql`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  } finally {
    server.stop(true)
  }
}

describe('native-release EAS GraphQL guard', () => {
  it('passes on the schema it was written against', async () => {
    const { exitCode, stdout, stderr } = await runChecker(snapshot())
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('OK')
  }, 30_000)

  it('fails when an argument keeps its name but loses its type', async () => {
    const schema = snapshot()
    const uploadSession = schema.types.UploadSession as {
      fields: { name: string; args: { name: string; type: unknown }[] }[]
    }
    const field = uploadSession.fields.find((f) => f.name === 'createUploadSession')!
    const typeArg = field.args.find((a) => a.name === 'type')!
    // The exact defect: app-scoped upload sessions, which can only take a profile image.
    typeArg.type = { kind: 'ENUM', name: 'AppUploadSessionType' }

    const { exitCode, stderr } = await runChecker(schema)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('uploadSession.createUploadSession(type:) is AppUploadSessionType')
  }, 30_000)

  it('fails when a resource class the price table needs disappears', async () => {
    const schema = snapshot()
    const resourceClass = schema.types.BuildResourceClass as { enumValues: { name: string }[] }
    resourceClass.enumValues = resourceClass.enumValues.filter((v) => v.name !== 'IOS_M_MEDIUM')

    const { exitCode, stderr } = await runChecker(schema)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('BuildResourceClass.IOS_M_MEDIUM is gone')
  }, 30_000)

  it('fails when the resource class is no longer an enum on BuildParamsInput', async () => {
    const schema = snapshot()
    const buildParams = schema.types.BuildParamsInput as { inputFields: { name: string; type: unknown }[] }
    buildParams.inputFields = buildParams.inputFields.map((f) =>
      f.name === 'resourceClass' ? { ...f, type: { kind: 'SCALAR', name: 'String' } } : f,
    )

    const { exitCode, stderr } = await runChecker(schema)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('BuildParamsInput.resourceClass is String')
  }, 30_000)

  it('fails when an org-creation mutation appears', async () => {
    const schema = snapshot()
    schema.root.__schema.mutationType.fields.push({
      name: 'organization',
      type: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'OrganizationMutation' } },
    })

    const { exitCode, stderr } = await runChecker(schema)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('organization now exists')
  }, 30_000)
})
