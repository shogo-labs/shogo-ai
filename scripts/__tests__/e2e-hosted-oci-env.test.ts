// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The kubeconfig `oci ce cluster create-kubeconfig` writes is an exec plugin:
 * every later `kubectl` call shells out to `oci ce cluster generate-token`,
 * which needs the OCI_CLI_* credentials in *its* environment. In
 * `e2e-hosted.yml` they were set on the Configure step only, so the capacity
 * probes reported "cluster not reachable … (unknown)" and Diagnostics captured
 * nothing but `executable oci failed` (2026-11-26, v2.6.7 staging red).
 *
 * Guard: every job that configures kubectl carries the credentials at job
 * level, and the Playwright job (which runs spec code) never does.
 *
 * Read as text, same approach as `e2e-artifact-namespace.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const HOSTED = readFileSync(join(root, '.github/workflows/e2e-hosted.yml'), 'utf8')

const CREDS = [
  'OCI_CLI_USER',
  'OCI_CLI_TENANCY',
  'OCI_CLI_FINGERPRINT',
  'OCI_CLI_KEY_CONTENT',
  'OCI_CLI_REGION',
] as const

/** Split `jobs:` into `{ key: body }` by the two-space job headers. */
export function jobsOf(text: string): Record<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const out: Record<string, string> = {}
  const re = /^ {2}([A-Za-z0-9_-]+):\n/gm
  const heads = [...body.matchAll(re)]
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index! : body.length
    out[m[1]] = body.slice(m.index!, end)
  })
  return out
}

/** The job-level `env:` block (4-space key, before `steps:`), or ''. */
export function jobEnv(job: string): string {
  const head = job.slice(0, job.indexOf('\n    steps:\n'))
  const m = head.match(/\n {4}env:\n((?: {6}.*\n|\s*\n)+)/)
  return m ? m[1] : ''
}

const jobs = jobsOf(HOSTED)

describe('e2e-hosted.yml OCI credentials reach every kubectl call', () => {
  const kubectlJobs = Object.entries(jobs).filter(([, b]) => b.includes('oci ce cluster create-kubeconfig'))

  it('finds the jobs that configure kubectl', () => {
    expect(kubectlJobs.map(([k]) => k).sort()).toEqual(['diagnostics', 'postrun', 'preflight'])
  })

  for (const [key, body] of kubectlJobs) {
    it(`${key}: OCI_CLI_* are job-level, not step-scoped`, () => {
      const env = jobEnv(body)
      for (const name of CREDS) expect(env).toContain(`${name}:`)
      const steps = body.slice(body.indexOf('\n    steps:\n'))
      for (const name of CREDS) expect(steps).not.toMatch(new RegExp(`^ {10}${name}:`, 'm'))
    })
  }

  it('the Playwright job (spec code) never gets cluster credentials', () => {
    expect(jobs.playwright).toBeDefined()
    for (const name of CREDS) expect(jobs.playwright).not.toContain(name)
  })
})
