// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A tunnelled call carries a workspace id from the cloud side. Only an id this
 * desktop does not know may be remapped — a machine workspace picked in Studio
 * arrives as the desktop's own id and must survive the hop (SHO-54).
 */
import { describe, expect, test } from 'bun:test'
import { resolveTunnelWorkspaceId } from '../lib/tunnel-workspace'

function prismaWith(ids: string[]) {
  return {
    workspace: {
      findUnique: async ({ where }: any) => (ids.includes(where.id) ? { id: where.id } : null),
      findFirst: async () => (ids.length ? { id: ids[0] } : null),
    },
  } as any
}

describe('resolveTunnelWorkspaceId', () => {
  test('keeps a workspace this desktop knows', async () => {
    expect(await resolveTunnelWorkspaceId(prismaWith(['lw-personal', 'lw-team']), 'lw-team')).toBe(
      'lw-team',
    )
  })

  test('remaps a cloud id this desktop has never heard of', async () => {
    expect(await resolveTunnelWorkspaceId(prismaWith(['lw-personal', 'lw-team']), 'cloud-ws')).toBe(
      'lw-personal',
    )
  })

  test('falls back to the machine’s first workspace when none is given', async () => {
    expect(await resolveTunnelWorkspaceId(prismaWith(['lw-personal']), undefined)).toBe('lw-personal')
  })

  test('returns the original id when the machine has no workspace yet', async () => {
    expect(await resolveTunnelWorkspaceId(prismaWith([]), 'cloud-ws')).toBe('cloud-ws')
  })
})
