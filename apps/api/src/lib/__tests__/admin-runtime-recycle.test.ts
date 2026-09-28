// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { recycleRuntimes, type RecycleDeps } from '../admin-runtime-recycle'
import type { RecycleResult } from '../metal-warm-pool-controller'

const ACTOR = { id: 'admin-1', email: 'ops@shogo.ai' }

function deps(over: Partial<RecycleDeps> & { results?: Record<string, RecycleResult> } = {}) {
  const calls: Array<{ key: string; force?: boolean; env?: Record<string, string> }> = []
  const audits: Array<Record<string, unknown>> = []
  let t = 0
  const d: RecycleDeps = {
    recycle: async (key, opts) => {
      const env = opts.buildEnv ? await opts.buildEnv() : undefined
      calls.push({ key, force: opts.force, env })
      return over.results?.[key] ?? { found: false, ok: false }
    },
    loadAnchorArgs: async () => ({
      workspaceId: 'w1',
      attachedProjectIds: ['p1', 'p2'],
      localFolders: [],
      readonlyProjectIds: [],
    }),
    buildWorkspaceEnv: async (workspaceId, attached, opts) => ({
      WORKSPACE_ID: workspaceId,
      WORKSPACE_PROJECT_IDS: attached.join(','),
      ANCHOR: opts.anchorProjectId ?? '',
      RUNTIME_AUTH_SECRET: 'wrt-tok',
    }),
    coldBoot: async () => 'http://guest:8080',
    previewStatus: async () => ({ apiReady: true, apiServerPhase: 'healthy' }),
    audit: (e) => audits.push(e),
    sleep: async (ms) => {
      t += ms
    },
    now: () => t,
    ...over,
  }
  return { d, calls, audits }
}

describe('recycleRuntimes', () => {
  it('requires a project or workspace', async () => {
    const { d } = deps()
    expect((await recycleRuntimes({}, ACTOR, d)).status).toBe(400)
  })

  it('recycles the anchored runtime with the open env, cold-boots and waits for the API', async () => {
    const { d, calls, audits } = deps({
      results: { 'ws:proj:p1': { found: true, ok: true, hostId: 'ash-1', report: { steps: [] } } },
    })
    let seenToken: string | undefined
    d.previewStatus = async (_url, token) => {
      seenToken = token
      return { apiReady: true, apiServerPhase: 'healthy' }
    }
    const r = await recycleRuntimes({ projectId: 'p1', reason: 'EADDRINUSE loop' }, ACTOR, d)
    expect(r.status).toBe(200)
    expect(calls.map((c) => c.key)).toEqual(['ws:proj:p1', 'p1'])
    expect(calls[0].env).toMatchObject({ WORKSPACE_PROJECT_IDS: 'p1,p2', ANCHOR: 'p1' })
    expect(r.body.coldBoot).toMatchObject({ ok: true, apiReady: true, url: 'http://guest:8080' })
    expect(seenToken).toBe('wrt-tok')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      event: 'admin.runtime.recycle',
      actorId: 'admin-1',
      outcome: 'recycled',
      reason: 'EADDRINUSE loop',
    })
  })

  it('an aborted recycle is a 409 with no cold boot', async () => {
    let booted = false
    const { d, audits } = deps({
      results: {
        'ws:proj:p1': {
          found: true,
          ok: false,
          report: { aborted: true, steps: [{ step: 'data', ok: false, detail: 'S3 503' }] },
        },
      },
      coldBoot: async () => {
        booted = true
        return 'http://g'
      },
    })
    const r = await recycleRuntimes({ projectId: 'p1' }, ACTOR, d)
    expect(r.status).toBe(409)
    expect(booted).toBe(false)
    expect(audits[0]).toMatchObject({ outcome: 'aborted' })
  })

  it('404 when no host holds any of the keys', async () => {
    const { d, audits } = deps()
    const r = await recycleRuntimes({ projectId: 'p1' }, ACTOR, d)
    expect(r.status).toBe(404)
    expect(audits[0]).toMatchObject({ outcome: 'not-found' })
  })

  it('passes force through and targets the workspace session key', async () => {
    const { d, calls } = deps({ results: { 'ws:w1': { found: true, ok: true } } })
    const r = await recycleRuntimes({ workspaceId: 'w1', force: true }, ACTOR, d)
    expect(r.status).toBe(200)
    expect(calls).toEqual([{ key: 'ws:w1', force: true, env: undefined }])
    expect(r.body.coldBoot).toBeUndefined()
  })

  it('reports an API that never becomes ready without failing the recycle', async () => {
    const { d } = deps({
      results: { 'ws:proj:p1': { found: true, ok: true } },
      previewStatus: async () => ({ apiReady: false, apiServerPhase: 'crashed' }),
    })
    const r = await recycleRuntimes({ projectId: 'p1' }, ACTOR, d)
    expect(r.status).toBe(200)
    expect(r.body.coldBoot).toMatchObject({ ok: false, apiReady: false, apiServerPhase: 'crashed' })
  })
})
