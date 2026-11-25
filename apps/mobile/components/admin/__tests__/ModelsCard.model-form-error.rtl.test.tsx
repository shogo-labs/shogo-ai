// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → Settings → Models: a rejected save has to say so.
 *
 * SHO-558: the card kept the API's message in `error` and rendered it only in
 * the section behind the edit `<Modal>`, so a rejected save left the modal open
 * and silent — indistinguishable from "Save changes does nothing". The message
 * belongs in the modal, next to the button the admin just pressed.
 *
 * The other half of the same failure was the payload itself: the form always
 * sends `family` (and the full row), so the family list this form offers must be
 * the one the API validates against — both now come from
 * `@shogo/model-catalog`'s `MODEL_FAMILIES`.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { MODEL_FAMILIES } from '@shogo/model-catalog'

// A real <input> only emits `onChange`; the card listens for RN's
// `onChangeText` + `onBlur`.
const TextInput = forwardRef(function TextInput(props: any, ref: any) {
  const { onChangeText, onBlur, secureTextEntry, placeholderTextColor, autoCapitalize, autoCorrect, ...rest } = props
  return createElement('input', {
    ...rest,
    ref,
    onChange: (e: any) => onChangeText?.(e.target.value),
    onBlur: () => onBlur?.(),
  })
})

// React Native's Pressable exposes `onPress`; a DOM button needs `onClick`.
// `testID` becomes `data-testid` so the tests can grab a specific row button.
const Pressable = forwardRef(function Pressable(props: any, ref: any) {
  const { onPress, children, style, testID, ...rest } = props
  return createElement('button', { ...rest, ref, 'data-testid': testID, onClick: onPress }, children)
})

mock.module('react-native', () => createReactNativeMock({ TextInput, Pressable }))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('../../../lib/visible-models', () => ({
  invalidateVisibleModelsCache: () => {},
}))

const { ModelsCard } = await import('../ModelsCard')

/** A Gemini row as the API serves it: `family: 'gemini'` (the value that used
 *  to be rejected with `400 invalid family` and never persisted). */
const GEMINI_MODEL = {
  id: 'model-gemini-carbon',
  provider: 'google',
  providerId: null,
  apiModel: 'gemini-4-carbon',
  displayName: 'Gemini 4 Carbon',
  shortDisplayName: 'Carbon',
  tier: 'premium',
  family: 'gemini',
  generation: 'current',
  maxOutputTokens: 64000,
  enabled: true,
  sortOrder: null,
  aliases: ['gemini-4-carbon'],
  capabilities: null,
  description: null,
  contextWindow: 1048576,
  reasoningEffort: 'medium',
  inputPerMillion: 1.25,
  cachedInputPerMillion: 0,
  cacheWritePerMillion: 0,
  outputPerMillion: 5,
  createdAt: '2026-11-20T15:54:00.000Z',
  updatedAt: '2026-11-20T15:54:00.000Z',
  updatedBy: 'seed:db-models',
}

function fakePlatform(over: Record<string, any> = {}) {
  return {
    listModels: mock(async () => [GEMINI_MODEL] as any[]),
    listModelProviders: mock(async () => [] as any[]),
    getPricingStatus: mock(async () => ({ refreshedAt: new Date().toISOString(), stale: false })),
    refreshModelPricing: mock(async () => ({ refreshedAt: new Date().toISOString() })),
    getPublicModels: mock(async () => [] as any[]),
    putPublicModels: mock(async (list: any[]) => list),
    getAdminProviderKeyMasks: mock(async () => ({}) as Record<string, any>),
    getProviderKeyMasks: mock(async () => ({}) as Record<string, string>),
    putAdminProviderKeys: mock(async () => {}),
    putProviderKeys: mock(async () => {}),
    createModel: mock(async () => ({})),
    updateModel: mock(async () => ({})),
    deleteModel: mock(async () => {}),
    getProviderModels: mock(async () => ({ ok: true, models: [] })),
    ...over,
  } as any
}

/** The card's error slot inside the edit modal (a `testID` the RN mock renders
 *  as `data-rn-shim`), separate from the one in the section behind it. */
function modalError(): HTMLElement | null {
  return document.querySelector('[data-rn-shim="model-form-error"]')
}

function editButton(): HTMLElement {
  const el = document.querySelector('[data-testid="edit-model-model-gemini-carbon"]')
  if (!el) throw new Error('edit button for the Gemini row is missing')
  return el as HTMLElement
}

describe('model form: a rejected save is visible in the modal', () => {
  test("offers every family the catalog defines (including 'gemini')", async () => {
    render(createElement(ModelsCard, { platform: fakePlatform(), localMode: false }))
    await waitFor(() => expect(screen.queryAllByText('Gemini 4 Carbon').length).toBeGreaterThan(0))

    fireEvent.click(editButton())

    await waitFor(() => expect(screen.queryAllByText('Family').length).toBeGreaterThan(0))
    for (const family of MODEL_FAMILIES) {
      expect(screen.queryAllByText(family).length).toBeGreaterThan(0)
    }
    expect(MODEL_FAMILIES).toContain('gemini')
  })

  test('shows the API error inside the modal and keeps the edit open', async () => {
    const platform = fakePlatform({
      updateModel: mock(async () => {
        throw new Error('invalid tier')
      }),
    })
    render(createElement(ModelsCard, { platform, localMode: false }))
    await waitFor(() => expect(screen.queryAllByText('Gemini 4 Carbon').length).toBeGreaterThan(0))

    fireEvent.click(editButton())
    await waitFor(() => expect(screen.queryAllByText('high').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('high')[0])

    expect(modalError()).toBeNull()
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(modalError()?.textContent).toContain('invalid tier'))
    // The edit is still open, so the message is in front of the admin rather
    // than behind a modal they have to dismiss to discover it.
    expect(screen.getByText('Save changes')).toBeInTheDocument()
    // And the row's own family went out with the payload — the value the API
    // used to reject outright.
    expect(platform.updateModel).toHaveBeenCalledWith(
      'model-gemini-carbon',
      expect.objectContaining({ family: 'gemini', reasoningEffort: 'high' }),
    )
  })

  test('saves supported reasoning choices while preserving other model capabilities', async () => {
    const model = {
      ...GEMINI_MODEL,
      capabilities: { supportsVideoInput: true, reasoningEfforts: ['low'] },
    }
    const platform = fakePlatform({
      listModels: mock(async () => [model] as any[]),
    })
    render(createElement(ModelsCard, { platform, localMode: false }))
    await waitFor(() => expect(screen.queryAllByText('Gemini 4 Carbon').length).toBeGreaterThan(0))

    fireEvent.click(editButton())
    await waitFor(() => expect(screen.getByTestId('admin-reasoning-effort-low')).toBeTruthy())
    fireEvent.click(screen.getByTestId('admin-reasoning-effort-high'))
    fireEvent.click(screen.getByTestId('admin-reasoning-effort-low'))
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(platform.updateModel).toHaveBeenCalledWith(
      'model-gemini-carbon',
      expect.objectContaining({
        capabilities: { supportsVideoInput: true, reasoningEfforts: ['high'] },
      }),
    ))
  })
})
