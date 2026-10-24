// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → Settings → Models: provider-key rows.
 *
 * SHO-37 added a Tripo (3D) key row. The row is driven entirely by
 * `KEY_PROVIDERS` + the store call the card already makes per provider, so the
 * regression this guards is someone rendering a key row for a provider the
 * admin route (`PUT /api/admin/settings/provider-keys`) or the desktop route
 * (`PUT /api/local/api-keys`) does not accept — the field then saves nothing.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

// A real <input> only emits `onChange`; the card listens for RN's
// `onChangeText` + `onBlur`. Strip the RN-only props so React does not warn
// about unknown DOM attributes.
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
const Pressable = forwardRef(function Pressable(props: any, ref: any) {
  const { onPress, children, style, ...rest } = props
  return createElement('button', { ...rest, ref, onClick: onPress }, children)
})

mock.module('react-native', () => createReactNativeMock({ TextInput, Pressable }))
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('../../../lib/visible-models', () => ({
  invalidateVisibleModelsCache: () => {},
}))

const { ModelsCard } = await import('../ModelsCard')

function fakePlatform(over: Record<string, any> = {}) {
  return {
    listModels: mock(async () => [] as any[]),
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

/** Type into the row and blur it — the card's save-on-blur contract. */
function typeAndBlur(placeholder: string, value: string) {
  const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

const TRIPO_PLACEHOLDER = 'Tripo (3D) API key (tsk_…)'
const HIGGSFIELD_PLACEHOLDER = 'Higgsfield (video, images, Genjutsu) API key (key_id:key_secret)'

describe('provider-key rows', () => {
  test('renders the Tripo (3D) row next to the existing providers (cloud)', async () => {
    const platform = fakePlatform()
    render(createElement(ModelsCard, { platform, localMode: false }))

    await waitFor(() => expect(screen.getByText('Tripo (3D)')).toBeInTheDocument())
    for (const name of ['Anthropic', 'OpenAI', 'OpenRouter', 'Higgsfield (video, images, Genjutsu)']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
    // One "Not configured" per key row (5 providers), none of them pre-set.
    expect(screen.getAllByText('Not configured')).toHaveLength(5)
  })

  test('cloud mode saves the Higgsfield key through the admin route', async () => {
    const platform = fakePlatform()
    render(createElement(ModelsCard, { platform, localMode: false }))

    await waitFor(() => expect(screen.getByText('Higgsfield (video, images, Genjutsu)')).toBeInTheDocument())
    // The default media provider's key must round-trip like every other row.
    typeAndBlur(HIGGSFIELD_PLACEHOLDER, 'hf_id:hf_secret')

    await waitFor(() => expect(platform.putAdminProviderKeys).toHaveBeenCalledWith({ higgsfield: 'hf_id:hf_secret' }))
  })

  test('cloud mode saves the Tripo key through the admin route', async () => {
    const platform = fakePlatform()
    render(createElement(ModelsCard, { platform, localMode: false }))

    await waitFor(() => expect(screen.getByText('Tripo (3D)')).toBeInTheDocument())
    typeAndBlur(TRIPO_PLACEHOLDER, 'tsk_x')

    await waitFor(() => expect(platform.putAdminProviderKeys).toHaveBeenCalledWith({ tripo: 'tsk_x' }))
    expect(platform.putProviderKeys).not.toHaveBeenCalled()
  })

  test('desktop (local) mode saves the Tripo key through the local route', async () => {
    const platform = fakePlatform()
    render(createElement(ModelsCard, { platform, localMode: true }))

    await waitFor(() => expect(screen.getByText('Tripo (3D)')).toBeInTheDocument())
    typeAndBlur(TRIPO_PLACEHOLDER, 'tsk_local')

    await waitFor(() => expect(platform.putProviderKeys).toHaveBeenCalledWith({ tripo: 'tsk_local' }))
    expect(platform.putAdminProviderKeys).not.toHaveBeenCalled()
    // Local mode drives its masks from /api/local/api-keys, not the admin route.
    expect(platform.getProviderKeyMasks).toHaveBeenCalled()
    expect(platform.getAdminProviderKeyMasks).not.toHaveBeenCalled()
  })

  test('a configured Tripo key shows its mask and Clear sends null', async () => {
    const platform = fakePlatform({
      getAdminProviderKeyMasks: mock(async () => ({ tripo: { configured: true, mask: 'tsk_…_key' } })),
    })
    render(createElement(ModelsCard, { platform, localMode: false }))

    await waitFor(() => expect(screen.getByText('tsk_…_key')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Clear'))

    await waitFor(() => expect(platform.putAdminProviderKeys).toHaveBeenCalledWith({ tripo: null }))
  })
})
