// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a background job runs (SHO-285 Update 2): the cloud fires the unpinned
 * ones, each desktop fires its own, and the two filters are exact complements so
 * a job can never fire twice. Also covers the cloud's refusal to let a device
 * rewrite the account's Personal.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { applyPersonalWorkspaceIdentity } from '../machine-sync/ingest.ts'

const ORIGINAL_LOCAL_MODE = process.env.SHOGO_LOCAL_MODE

afterEach(() => {
  if (ORIGINAL_LOCAL_MODE === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = ORIGINAL_LOCAL_MODE
})

async function placement() {
  // Fresh module per case: the desktop/cloud decision is read from the env.
  const mod = await import(`../job-placement.ts?case=${Math.random()}`)
  return mod as typeof import('../job-placement.ts')
}

describe('job placement', () => {
  test('the cloud fires unpinned jobs of workspaces it runs', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const { schedulePlacementWhere, heartbeatPlacementWhere, jobPlacement } = await placement()
    expect(schedulePlacementWhere()).toEqual({
      runOnInstanceId: null,
      workspace: { hostInstanceId: null },
    })
    expect(heartbeatPlacementWhere()).toEqual({
      runOnInstanceId: null,
      project: { workspace: { hostInstanceId: null } },
    })
    // A job created in the cloud is the cloud's.
    expect(jobPlacement()).toBeNull()
  })

  test('a desktop fires its own jobs and the local-only ones, never the Personal’s unpinned jobs', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    const { schedulePlacementWhere, heartbeatPlacementWhere } = await placement()
    // No tunnel yet (an unpaired desktop): only local-only workspaces.
    expect(schedulePlacementWhere()).toEqual({
      runOnInstanceId: null,
      workspace: { personalOwnerId: null },
    })
    expect(heartbeatPlacementWhere()).toEqual({
      runOnInstanceId: null,
      project: { workspace: { personalOwnerId: null } },
    })
  })

  test('the two filters cannot both claim a job', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const cloud = await placement()
    const cloudWhere = cloud.schedulePlacementWhere() as any
    process.env.SHOGO_LOCAL_MODE = 'true'
    const desktop = await placement()
    const desktopWhere = desktop.schedulePlacementWhere() as any

    // Cloud: unpinned + unhosted. Desktop: pinned to me, or unpinned + not the
    // Personal. A job that is unpinned in the Personal is the cloud's alone.
    expect(cloudWhere.runOnInstanceId).toBeNull()
    expect(cloudWhere.workspace.hostInstanceId).toBeNull()
    expect(desktopWhere.workspace.personalOwnerId).toBeNull()
  })
})

describe('the cloud keeps the Personal’s identity', () => {
  const existing = {
    id: 'cloud-personal',
    slug: 'user-abc-personal',
    kind: 'personal',
    personalOwnerId: 'user-1',
    hostInstanceId: null,
  }

  test('a device cannot rename, re-slug or host the Personal', () => {
    const fromDevice = {
      id: 'cloud-personal',
      slug: 'local-user-personal',
      kind: 'personal',
      personalOwnerId: null,
      hostInstanceId: 'inst-1',
      name: 'Local User Personal',
    }
    const out = applyPersonalWorkspaceIdentity(existing, fromDevice)
    expect(out.slug).toBe('user-abc-personal')
    expect(out.hostInstanceId).toBeNull()
    expect(out.personalOwnerId).toBe('user-1')
    // The contents still come from the device.
    expect(out.name).toBe('Local User Personal')
  })

  test('a team workspace is left exactly as the device sent it', () => {
    const row = { id: 'ws-1', slug: 'my-workspace-m-instabc', hostInstanceId: 'inst-1' }
    expect(applyPersonalWorkspaceIdentity({ id: 'ws-1', personalOwnerId: null }, row)).toEqual(row)
  })
})
