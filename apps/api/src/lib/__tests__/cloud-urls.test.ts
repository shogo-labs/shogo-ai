// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getShogoCloudUrl,
  getFrontendUrl,
  SHOGO_CLOUD_URL_DEFAULT,
} from '../cloud-urls'

const ENV_KEYS = ['SHOGO_CLOUD_URL', 'APP_URL', 'ALLOWED_ORIGINS', 'VITE_PORT'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('getShogoCloudUrl', () => {
  it('returns the production default when env is unset', () => {
    expect(getShogoCloudUrl()).toBe(SHOGO_CLOUD_URL_DEFAULT)
  })

  it('honours SHOGO_CLOUD_URL when set', () => {
    process.env.SHOGO_CLOUD_URL = 'https://staging.shogo.ai'
    expect(getShogoCloudUrl()).toBe('https://staging.shogo.ai')
  })

  it('trims a trailing slash', () => {
    process.env.SHOGO_CLOUD_URL = 'https://staging.shogo.ai/'
    expect(getShogoCloudUrl()).toBe('https://staging.shogo.ai')
  })

  it('treats an empty SHOGO_CLOUD_URL as unset', () => {
    process.env.SHOGO_CLOUD_URL = ''
    expect(getShogoCloudUrl()).toBe(SHOGO_CLOUD_URL_DEFAULT)
  })
})

describe('getFrontendUrl', () => {
  it('prefers APP_URL when present', () => {
    process.env.APP_URL = 'https://app.example.com'
    process.env.ALLOWED_ORIGINS = 'https://other.example.com'
    expect(getFrontendUrl()).toBe('https://app.example.com')
  })

  it('falls back to first ALLOWED_ORIGINS entry', () => {
    process.env.ALLOWED_ORIGINS = 'https://first.example.com, https://second.example.com'
    expect(getFrontendUrl()).toBe('https://first.example.com')
  })

  it('skips ALLOWED_ORIGINS when the first entry is empty after trim', () => {
    process.env.ALLOWED_ORIGINS = ',  https://second.example.com'
    expect(getFrontendUrl()).toBe('http://localhost:3000')
  })

  it('uses VITE_PORT for the localhost fallback', () => {
    process.env.VITE_PORT = '5173'
    expect(getFrontendUrl()).toBe('http://localhost:5173')
  })

  it('defaults VITE_PORT to 3000 when unset or invalid', () => {
    expect(getFrontendUrl()).toBe('http://localhost:3000')
    process.env.VITE_PORT = 'not-a-number'
    expect(getFrontendUrl()).toBe('http://localhost:NaN')
  })
})
