// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isShogoCloudAuthed, isShogoCloudForwarding } from '../cloud-forwarding'

const ENV_KEYS = ['SHOGO_LOCAL_MODE', 'SHOGO_API_KEY', 'AI_MODE'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('cloud forwarding gates', () => {
  test('a cloud instance never relays to itself', () => {
    process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
    expect(isShogoCloudAuthed()).toBe(false)
    expect(isShogoCloudForwarding()).toBe(false)
  })

  test('a signed-out desktop relays nothing, even with an AI_MODE set', () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    expect(isShogoCloudAuthed()).toBe(false)
    expect(isShogoCloudForwarding()).toBe(false)

    process.env.AI_MODE = 'cloud'
    expect(isShogoCloudAuthed()).toBe(false)
    expect(isShogoCloudForwarding()).toBe(false)
  })

  test('a cloud-authed desktop forwards model calls unless AI_MODE opts out', () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = 'shogo_sk_linked'

    expect(isShogoCloudAuthed()).toBe(true)
    expect(isShogoCloudForwarding()).toBe(true)

    process.env.AI_MODE = 'api-keys'
    // Tools and integrations still relay: their provider keys exist only on the
    // cloud, so the AI_MODE opt-out only covers the model call itself.
    expect(isShogoCloudAuthed()).toBe(true)
    expect(isShogoCloudForwarding()).toBe(false)

    process.env.AI_MODE = 'local-llm'
    expect(isShogoCloudAuthed()).toBe(true)
    expect(isShogoCloudForwarding()).toBe(false)
  })
})
