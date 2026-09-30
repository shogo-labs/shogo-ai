// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { AUTO_MODEL_ID } from '@shogo/model-catalog'
import { pickSimilarModel } from '../similar-model'
import type { PickerModel } from '../visible-models'

const models: PickerModel[] = [
  { id: 'opus', displayName: 'Claude Opus', tier: 'premium', family: 'claude', provider: 'anthropic' },
  { id: 'sonnet', displayName: 'Claude Sonnet', tier: 'standard', family: 'claude', provider: 'anthropic' },
  { id: 'haiku', displayName: 'Claude Haiku', tier: 'economy', family: 'claude', provider: 'anthropic' },
  { id: 'gpt', displayName: 'GPT', tier: 'standard', family: 'gpt', provider: 'openai' },
  { id: 'gpt-pro', displayName: 'GPT Pro', tier: 'premium', family: 'gpt', provider: 'openai' },
] as PickerModel[]

describe('pickSimilarModel', () => {
  test('prefers the same tier from a different provider', () => {
    expect(pickSimilarModel('sonnet', models)?.id).toBe('gpt')
    expect(pickSimilarModel('opus', models)?.id).toBe('gpt-pro')
  })

  test('null when nothing else shares the tier', () => {
    expect(pickSimilarModel('haiku', models)).toBeNull()
  })

  test('null for Auto or an unknown model', () => {
    expect(pickSimilarModel(AUTO_MODEL_ID, models)).toBeNull()
    expect(pickSimilarModel('nope', models)).toBeNull()
  })
})
