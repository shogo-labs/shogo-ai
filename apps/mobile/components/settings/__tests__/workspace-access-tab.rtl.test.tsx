// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Members & access, the model half of a policy row (SHO-448).
 *
 * The screen has to be able to write all three model states, and opening a
 * `null`/`null` row and pressing save without touching anything has to write
 * `null`/`null` back. The old editor expanded "all models" into every tier the
 * catalog had that day, so an untouched save silently narrowed the row.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, disabled, onPress }: any) =>
      createElement(
        'div',
        {
          role: 'button',
          'aria-label': accessibilityLabel,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
  } as any),
)
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children }: any) => createElement('span', null, children),
  useAccountSheetIcons: (icons: Record<string, unknown>) => icons,
}))
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws-1' }),
}))
mock.module('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
}))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const members = [{ user: { id: 'u-1', name: 'Hana' } }]
mock.module('../../../lib/api', () => ({
  createHttpClient: () => http,
  api: { getWorkspaceMembers: async () => members },
}))

const { WorkspaceAccessTab } = await import('../WorkspaceAccessTab')

type Row = {
  subjectType: 'role' | 'group' | 'member'
  subjectId: string
  abilities: string[] | null
  modelTiers: string[] | null
  modelIds: string[] | null
  defaultModelId: string | null
  spendCapUsd: number | null
  spendPeriod: string | null
  requestsPerHour: number | null
}

const row = (over: Partial<Row> = {}): Row => ({
  subjectType: 'member',
  subjectId: 'u-1',
  abilities: ['agent.exec:use'],
  modelTiers: null,
  modelIds: null,
  defaultModelId: null,
  spendCapUsd: null,
  spendPeriod: null,
  requestsPerHour: null,
  ...over,
})

let policies: Row[]
const writes: Array<{ method: string; url: string; body: any }> = []

const http = {
  get: async (url: string) => {
    if (url.endsWith('/access/effective')) {
      return {
        data: {
          role: 'member',
          abilities: ['agent.exec:use'],
          models: ['economy-1'],
          defaultModelId: null,
          spendCapUsd: null,
          spendPeriod: null,
          requestsPerHour: null,
          reasons: ['role member'],
        },
      }
    }
    if (url.endsWith('/access/policies')) {
      return {
        data: {
          policies,
          abilities: [{ id: 'agent.exec:use', label: 'Run shell commands', group: 'Agent' }],
          modelTiers: ['economy', 'standard', 'premium'],
          models: [
            { id: 'economy-1', displayName: 'Economy One', tier: 'economy' },
            { id: 'premium-1', displayName: 'Premium One', tier: 'premium' },
          ],
        },
      }
    }
    if (url.includes('/access/requests')) return { data: { requests: [] } }
    if (url.includes('/access/audit')) return { data: { events: [], shadow: [] } }
    return { data: null }
  },
  put: async (url: string, body: any) => {
    writes.push({ method: 'PUT', url, body })
    return { data: { ok: true } }
  },
  post: async (url: string, body: any) => {
    writes.push({ method: 'POST', url, body })
    return { data: { ok: true } }
  },
  delete: async (url: string) => {
    writes.push({ method: 'DELETE', url, body: undefined })
    return { data: { ok: true } }
  },
}

beforeEach(() => {
  policies = [row()]
  writes.length = 0
})

afterEach(() => {
  cleanup()
})

/** Open the member editor for Hana, whose row is the one under test. */
async function openMemberEditor() {
  render(<WorkspaceAccessTab />)
  fireEvent.click(await screen.findByLabelText('Member'))
  fireEvent.click(await screen.findByLabelText('Hana'))
  await screen.findByLabelText('All models under the ceiling')
}

const save = () => fireEvent.click(screen.getByLabelText('Save policy'))

describe('WorkspaceAccessTab — model grant states (SHO-448)', () => {
  test('a null/null row opens as "all models" and saves back as null/null', async () => {
    await openMemberEditor()

    // "All models" is the selected state, so no tier or model chips are shown.
    expect(screen.queryByLabelText('Tier economy')).toBeNull()
    expect(screen.queryByLabelText('Model Premium One')).toBeNull()

    save()
    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0].body).toEqual({
      subjectType: 'member',
      subjectId: 'u-1',
      abilities: ['agent.exec:use'],
      grantsAllModels: true,
      modelTiers: null,
      modelIds: null,
      defaultModelId: null,
      spendCapUsd: null,
      spendPeriod: null,
      requestsPerHour: null,
    })
  })

  test('"these tiers" writes the tier list and clears the id list', async () => {
    await openMemberEditor()

    fireEvent.click(screen.getByLabelText('These tiers'))
    fireEvent.click(await screen.findByLabelText('Tier economy'))
    save()

    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0].body.grantsAllModels).toBe(false)
    expect(writes[0].body.modelTiers).toEqual(['economy'])
    expect(writes[0].body.modelIds).toBeNull()
  })

  test('"these models" writes the id list and clears the tier list', async () => {
    await openMemberEditor()

    fireEvent.click(screen.getByLabelText('These models'))
    fireEvent.click(await screen.findByLabelText('Model Premium One'))
    save()

    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0].body.grantsAllModels).toBe(false)
    expect(writes[0].body.modelIds).toEqual(['premium-1'])
    expect(writes[0].body.modelTiers).toBeNull()
  })

  test('an explicit tier row opens on "these tiers" with its tiers selected', async () => {
    policies = [row({ modelTiers: ['premium'], modelIds: null })]
    await openMemberEditor()

    // The stored state is visible: the tier chips are on screen, and the row is
    // not silently read as "all models".
    expect(await screen.findByLabelText('Tier premium')).toBeTruthy()
    save()

    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0].body.grantsAllModels).toBe(false)
    expect(writes[0].body.modelTiers).toEqual(['premium'])
  })

  test('an ability-only row (empty arrays) says it grants no models', async () => {
    policies = [row({ modelTiers: [], modelIds: [] })]
    await openMemberEditor()

    expect(await screen.findByText(/this row adds none/)).toBeTruthy()
    save()

    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0].body.grantsAllModels).toBe(false)
    expect(writes[0].body.modelTiers).toEqual([])
  })

  test('the policy list names the state of every row', async () => {
    policies = [
      row({ subjectType: 'role', subjectId: 'member', modelTiers: null, modelIds: null }),
      row({ subjectType: 'member', subjectId: 'u-1', modelTiers: ['economy', 'standard'], modelIds: null }),
    ]
    render(<WorkspaceAccessTab />)

    expect(await screen.findByText(/all models under the ceiling/)).toBeTruthy()
    expect(screen.getByText(/tiers economy, standard/)).toBeTruthy()
  })
})
