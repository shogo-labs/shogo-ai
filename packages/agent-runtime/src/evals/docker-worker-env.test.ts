// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the Docker worker's `-e` flag builder (SHO-195).
 *
 * No Docker daemon, no container: `buildDockerEnvFlags` is a pure function, so
 * the container env a worker would boot with is asserted directly. The case
 * that matters is a plain single-project eval — the identity strip removes
 * `PROJECT_ID` and nothing puts it back, and `entrypoint.sh` exits 1 without
 * it, so `--track all` died on the first non-workspace eval.
 */

import { describe, expect, test } from 'bun:test'
import { buildDockerEnvFlags } from './docker-worker'
import { EVAL_WORKSPACE_ID, evalWorkspaceEnv, type EvalWorkerEnv } from './workspace-runtime-env'

const BASE_ENV: Array<[string, string]> = [
  ['NODE_ENV', 'development'],
  ['WORKSPACE_DIR', '/app/workspace'],
  ['PROJECT_ID', 'shogo-eval-worker-0'],
  ['RUNTIME_AUTH_SECRET', 'inherited-from-the-developer'],
]

/** `-e KEY=value` → `[KEY, value]`, so assertions do not care about order. */
function envPairs(flags: string[]): Array<[string, string]> {
  return flags.map((flag) => {
    const body = flag.replace(/^-e\s+/, '')
    const eq = body.indexOf('=')
    return [body.slice(0, eq), body.slice(eq + 1)] as [string, string]
  })
}

function valueOf(flags: string[], key: string): string | undefined {
  const matches = envPairs(flags).filter(([k]) => k === key)
  expect(matches.length).toBeLessThanOrEqual(1)
  return matches[0]?.[1]
}

describe('buildDockerEnvFlags', () => {
  test('a non-workspace eval keeps a PROJECT_ID', () => {
    const flags = buildDockerEnvFlags(BASE_ENV, evalWorkspaceEnv(undefined))
    expect(valueOf(flags, 'PROJECT_ID')).toBe('shogo-eval-worker-0')
  })

  test('a non-workspace eval boots no workspace runtime', () => {
    const flags = buildDockerEnvFlags(BASE_ENV, evalWorkspaceEnv(undefined))
    expect(valueOf(flags, 'WORKSPACE_RUNTIME')).toBeUndefined()
    expect(valueOf(flags, 'WORKSPACE_ID')).toBeUndefined()
  })

  test('the identity strip still removes inherited secrets', () => {
    const flags = buildDockerEnvFlags(BASE_ENV, evalWorkspaceEnv(undefined))
    expect(valueOf(flags, 'RUNTIME_AUTH_SECRET')).toBeUndefined()
    expect(valueOf(flags, 'WORKSPACE_DIR')).toBe('/app/workspace')
  })

  test('a workspace eval replaces PROJECT_ID instead of adding a second one', () => {
    const flags = buildDockerEnvFlags(BASE_ENV, evalWorkspaceEnv({ kind: 'team' }))
    expect(valueOf(flags, 'PROJECT_ID')).toBe(`ws:${EVAL_WORKSPACE_ID}`)
    expect(valueOf(flags, 'WORKSPACE_RUNTIME')).toBe('true')
    expect(valueOf(flags, 'WORKSPACE_KIND')).toBe('team')
  })

  test('a delta that neither sets nor strips PROJECT_ID leaves the base one', () => {
    const delta: EvalWorkerEnv = { set: { WORKSPACE_RUNTIME: 'true' }, unset: ['RUNTIME_AUTH_SECRET'] }
    const flags = buildDockerEnvFlags(BASE_ENV, delta)
    expect(valueOf(flags, 'PROJECT_ID')).toBe('shogo-eval-worker-0')
    expect(valueOf(flags, 'RUNTIME_AUTH_SECRET')).toBeUndefined()
  })

  test('with no delta every base flag survives untouched', () => {
    const flags = buildDockerEnvFlags(BASE_ENV)
    expect(envPairs(flags)).toEqual(BASE_ENV)
  })

  test('a base env with no PROJECT_ID gains none', () => {
    const flags = buildDockerEnvFlags(
      BASE_ENV.filter(([key]) => key !== 'PROJECT_ID'),
      evalWorkspaceEnv(undefined),
    )
    expect(valueOf(flags, 'PROJECT_ID')).toBeUndefined()
  })
})
