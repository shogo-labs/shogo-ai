// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests that the picker's data source (apps/mobile/lib/visible-models.ts) is
 * workspace-aware: when an active workspace is selected it reads the
 * workspace-scoped endpoint (the admin-curated subset); otherwise it reads the
 * unscoped platform set. The cache is keyed per workspace.
 *
 * Run: bun test apps/mobile/lib/__tests__/visible-models-workspace.test.tsx
 */

import { act, render } from '@testing-library/react'
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import * as React from 'react'

// Control the active workspace id the module reads.
let activeWorkspaceId: string | null = null
mock.module('../workspace-store', () => ({
  getActiveWorkspaceId: () => activeWorkspaceId,
  setActiveWorkspaceId: () => {},
}))

mock.module('../api', () => ({ createHttpClient: () => ({}) }))

// Record which endpoint the picker hit.
const calls: string[] = []
const PLATFORM_PAYLOAD = {
  catalogIds: null,
  openrouterModels: [],
  catalogModels: [{ id: 'platform-model', provider: 'anthropic', displayName: 'Platform Model', tier: 'standard' }],
}
const WORKSPACE_PAYLOAD = {
  catalogIds: null,
  openrouterModels: [],
  allowedModelIds: ['ws-model'],
  catalogModels: [{ id: 'ws-model', provider: 'anthropic', displayName: 'Workspace Model', tier: 'standard' }],
}

mock.module('@shogo-ai/sdk', () => ({
  PlatformApi: class {
    async getVisibleModels() {
      calls.push('platform')
      return PLATFORM_PAYLOAD
    }
    async getWorkspaceVisibleModels(id: string) {
      calls.push(`workspace:${id}`)
      return WORKSPACE_PAYLOAD
    }
  },
}))

const { useVisibleModels } = await import('../visible-models')

function Probe({ expose }: { expose: (v: any) => void }) {
  const snapshot = useVisibleModels()
  expose(snapshot)
  return null
}

async function flush() {
  // Let the revalidate promise (resolved synchronously by the SDK mock) settle.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  calls.length = 0
  try { (globalThis as any).localStorage?.clear?.() } catch { /* ignore */ }
})

describe('useVisibleModels (workspace-aware)', () => {
  test('reads the platform endpoint when no workspace is active', async () => {
    activeWorkspaceId = null
    let snapshot: any = undefined
    await act(async () => {
      render(<Probe expose={(v) => { snapshot = v }} />)
    })
    await flush()
    expect(calls).toContain('platform')
    expect(calls.some((c) => c.startsWith('workspace:'))).toBe(false)
    expect(snapshot?.catalogModels?.[0]?.id).toBe('platform-model')
  })

  test('reads the workspace-scoped endpoint when a workspace is active', async () => {
    activeWorkspaceId = 'ws-42'
    let snapshot: any = undefined
    await act(async () => {
      render(<Probe expose={(v) => { snapshot = v }} />)
    })
    await flush()
    expect(calls).toContain('workspace:ws-42')
    expect(snapshot?.catalogModels?.[0]?.id).toBe('ws-model')
    expect(snapshot?.allowedModelIds).toEqual(['ws-model'])
  })
})
