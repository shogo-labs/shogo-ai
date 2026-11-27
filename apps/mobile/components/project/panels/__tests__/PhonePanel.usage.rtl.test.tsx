// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-597: the phone panel's "Usage billed" is the one cost figure, like every
 * other Analytics surface. Local (desktop) voice usage is recorded billed 0
 * with the cost in the split fields, so reading `billedUsd` alone would show
 * $0.0000 on a local workspace while cloud shows the real spend.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock())
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const agentFetch = mock(async (_url: string): Promise<any> => ({ ok: false, status: 404, json: async () => ({}) }))
mock.module('../../../../lib/agent-fetch', () => ({ agentFetch }))
// Keep every real export (`createHttpClient` and friends are pulled in by the
// web panel shell) and only pin the base URL.
const realApi = await import('../../../../lib/api')
mock.module('../../../../lib/api', () => ({ ...realApi, API_URL: 'http://test.local' }))
mock.module('@/components/ui/spinner', () => ({
  Spinner: () => createElement('div', { 'data-testid': 'spinner' }),
}))

const { PhonePanel } = await import('../PhonePanel')

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const voiceTotals = (over: Record<string, any> = {}) => ({
  minutesInbound: 5,
  minutesOutbound: 2,
  billedUsdInbound: 1,
  billedUsdOutbound: 0,
  billedUsdNumbers: 0,
  calls: 3,
  inboundCalls: 2,
  outboundCalls: 1,
  ...over,
})

beforeEach(() => {
  agentFetch.mockReset()
})

afterEach(() => cleanup())

describe('PhonePanel usage billed', () => {
  test('a cloud workspace shows the billed total', async () => {
    agentFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/voice/usage/')) {
        return response({
          totals: voiceTotals({ billedUsd: 1.2, modelCostUsd: 1, shogoFeeUsd: 0.2, unitemizedUsd: 0, shogoFeePercent: 20 }),
        })
      }
      if (url.includes('/api/voice/calls/')) return response({ calls: [] })
      return response({ provisioned: false })
    })

    render(createElement(PhonePanel, { projectId: 'proj_1', visible: true }))

    expect(await screen.findByText('Recent usage')).toBeTruthy()
    expect(screen.getByText('$1.2000')).toBeTruthy()
    expect(screen.queryByText(/Shogo fee/i)).toBeNull()
  })

  test('a local workspace shows the cost the split carries, not $0.0000', async () => {
    agentFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/voice/usage/')) {
        // Local usage: nothing billed, the provider cost in the split.
        return response({
          totals: voiceTotals({ billedUsd: 0, modelCostUsd: 1, shogoFeeUsd: 0, unitemizedUsd: 0, shogoFeePercent: 20 }),
        })
      }
      if (url.includes('/api/voice/calls/')) return response({ calls: [] })
      return response({ provisioned: false })
    })

    render(createElement(PhonePanel, { projectId: 'proj_1', visible: true }))

    expect(await screen.findByText('Recent usage')).toBeTruthy()
    expect(screen.getByText('$1.0000')).toBeTruthy()
    expect(screen.queryByText('$0.0000')).toBeNull()
  })
})
