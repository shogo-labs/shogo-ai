// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import React, { useCallback, useEffect, useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import {
  getProvidersNeedingModelDiscovery,
  shouldLoadProviderModels,
  type ProviderModelDiscoveryState,
  type SetupProviderId,
} from '../providerModelDiscovery'

function baseState(
  overrides: Partial<ProviderModelDiscoveryState> = {},
): ProviderModelDiscoveryState {
  return {
    keyState: {},
    models: {},
    loadingModels: {},
    modelError: {},
    ...overrides,
  }
}

function DiscoveryHarness({
  discover,
}: {
  discover: (provider: SetupProviderId) => Promise<{ ok: boolean; models: unknown[]; error?: string }>
}) {
  const [keyState] = useState({ openai: { configured: true, mask: 'sk-***' } })
  const [models, setModels] = useState<Record<string, unknown[]>>({})
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({})
  const [modelError, setModelError] = useState<Record<string, string | null>>({})

  const loadProviderModels = useCallback(async (provider: SetupProviderId) => {
    setLoadingModels((prev) => ({ ...prev, [provider]: true }))
    setModelError((prev) => ({ ...prev, [provider]: null }))
    try {
      const result = await discover(provider)
      if (result.ok) {
        setModels((prev) => ({ ...prev, [provider]: result.models }))
      } else {
        setModelError((prev) => ({ ...prev, [provider]: result.error || 'Failed to fetch models' }))
      }
    } finally {
      setLoadingModels((prev) => ({ ...prev, [provider]: false }))
    }
  }, [discover])

  useEffect(() => {
    for (const provider of getProvidersNeedingModelDiscovery({
      keyState,
      models,
      loadingModels,
      modelError,
    })) {
      loadProviderModels(provider)
    }
  }, [keyState, models, loadingModels, modelError, loadProviderModels])

  return <div data-testid="error">{modelError.openai}</div>
}

describe('provider model discovery decision', () => {
  test('loads a configured provider when no model, request, or error exists', () => {
    expect(shouldLoadProviderModels('openai', baseState({
      keyState: { openai: { configured: true, mask: 'sk-***' } },
    }))).toBe(true)
  })

  test('does not load while a request is in flight, after models exist, or after an error', () => {
    expect(shouldLoadProviderModels('openai', baseState({
      keyState: { openai: { configured: true, mask: 'sk-***' } },
      loadingModels: { openai: true },
    }))).toBe(false)
    expect(shouldLoadProviderModels('openai', baseState({
      keyState: { openai: { configured: true, mask: 'sk-***' } },
      models: { openai: [] },
    }))).toBe(false)
    expect(shouldLoadProviderModels('openai', baseState({
      keyState: { openai: { configured: true, mask: 'sk-***' } },
      modelError: { openai: 'provider unavailable' },
    }))).toBe(false)
  })

  test('does not repeatedly refetch provider models after a failed discovery', async () => {
    let calls = 0
    const discover = async () => {
      calls += 1
      return { ok: false, models: [], error: 'provider unavailable' }
    }

    render(<DiscoveryHarness discover={discover} />)

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('provider unavailable'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toBe(1)
  })
})
