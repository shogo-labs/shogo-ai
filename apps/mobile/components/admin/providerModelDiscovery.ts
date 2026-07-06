// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export const SETUP_PROVIDER_IDS = ['openai', 'anthropic'] as const

export type SetupProviderId = (typeof SETUP_PROVIDER_IDS)[number]

export interface ProviderKeyState {
  configured: boolean
  mask: string
}

export interface ProviderModelDiscoveryState<TModel = unknown> {
  keyState: Record<string, ProviderKeyState>
  models: Record<string, TModel[]>
  loadingModels: Record<string, boolean>
  modelError: Record<string, string | null>
}

export function shouldLoadProviderModels<TModel>(
  provider: SetupProviderId,
  state: ProviderModelDiscoveryState<TModel>,
): boolean {
  return !!(
    state.keyState[provider]?.configured &&
    !state.models[provider] &&
    !state.loadingModels[provider] &&
    !state.modelError[provider]
  )
}

export function getProvidersNeedingModelDiscovery<TModel>(
  state: ProviderModelDiscoveryState<TModel>,
): SetupProviderId[] {
  return SETUP_PROVIDER_IDS.filter((provider) => shouldLoadProviderModels(provider, state))
}
