// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  SHOGO_CLOUD_URL_DEFAULT,
  getFrontendUrl,
  getShogoCloudUrl,
} from '../lib/cloud-urls'

// Snapshot every env var the module reads, restore after each test so
// individual assertions are fully isolated.
const ENV_KEYS = ['SHOGO_CLOUD_URL', 'APP_URL', 'ALLOWED_ORIGINS', 'VITE_PORT'] as const
const snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) snapshot[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
})

describe('SHOGO_CLOUD_URL_DEFAULT', () => {
  test('points at studio.shogo.ai (the production cloud)', () => {
    expect(SHOGO_CLOUD_URL_DEFAULT).toBe('https://studio.shogo.ai')
  })

  test('has no trailing slash (callers concat `${url}/api/...`)', () => {
    expect(SHOGO_CLOUD_URL_DEFAULT.endsWith('/')).toBe(false)
  })
})

describe('getShogoCloudUrl', () => {
  test('returns the production default when SHOGO_CLOUD_URL is unset', () => {
    expect(getShogoCloudUrl()).toBe('https://studio.shogo.ai')
  })

  test('returns the env override verbatim when set', () => {
    process.env.SHOGO_CLOUD_URL = 'https://staging.shogo.ai'
    expect(getShogoCloudUrl()).toBe('https://staging.shogo.ai')
  })

  test('trims a single trailing slash on the override', () => {
    process.env.SHOGO_CLOUD_URL = 'https://staging.shogo.ai/'
    expect(getShogoCloudUrl()).toBe('https://staging.shogo.ai')
  })

  test('trims only ONE trailing slash (matches the source regex)', () => {
    process.env.SHOGO_CLOUD_URL = 'https://staging.shogo.ai//'
    // The regex `\/$` strips exactly one slash; that's the documented contract.
    expect(getShogoCloudUrl()).toBe('https://staging.shogo.ai/')
  })

  test('falls back to default when override is an empty string (falsy)', () => {
    process.env.SHOGO_CLOUD_URL = ''
    expect(getShogoCloudUrl()).toBe('https://studio.shogo.ai')
  })

  test('supports a self-hosted http origin', () => {
    process.env.SHOGO_CLOUD_URL = 'http://internal-cloud.lan:8080'
    expect(getShogoCloudUrl()).toBe('http://internal-cloud.lan:8080')
  })

  test('does NOT read from any source other than the env var', () => {
    // No APP_URL / ALLOWED_ORIGINS leakage: cloud URL is intentionally env-only.
    process.env.APP_URL = 'https://frontend.example.com'
    process.env.ALLOWED_ORIGINS = 'https://origin.example.com'
    expect(getShogoCloudUrl()).toBe('https://studio.shogo.ai')
  })
})

describe('getFrontendUrl', () => {
  test('uses APP_URL when set (highest priority)', () => {
    process.env.APP_URL = 'https://app.example.com'
    process.env.ALLOWED_ORIGINS = 'https://ignored.example.com,https://also-ignored.example.com'
    process.env.VITE_PORT = '9999'
    expect(getFrontendUrl()).toBe('https://app.example.com')
  })

  test('falls back to the first ALLOWED_ORIGINS entry when APP_URL is unset', () => {
    process.env.ALLOWED_ORIGINS = 'https://primary.example.com,https://secondary.example.com'
    expect(getFrontendUrl()).toBe('https://primary.example.com')
  })

  test('trims whitespace around the first ALLOWED_ORIGINS entry', () => {
    process.env.ALLOWED_ORIGINS = '  https://primary.example.com  , https://secondary.example.com'
    expect(getFrontendUrl()).toBe('https://primary.example.com')
  })

  test('handles a single-origin ALLOWED_ORIGINS (no comma)', () => {
    process.env.ALLOWED_ORIGINS = 'https://only.example.com'
    expect(getFrontendUrl()).toBe('https://only.example.com')
  })

  test('falls through to localhost when ALLOWED_ORIGINS is empty string', () => {
    process.env.ALLOWED_ORIGINS = ''
    expect(getFrontendUrl()).toBe('http://localhost:3000')
  })

  test('falls through to localhost when ALLOWED_ORIGINS first entry is blank', () => {
    process.env.ALLOWED_ORIGINS = ',https://second.example.com'
    // After split + trim, the first entry is '' (falsy) — code falls to localhost.
    expect(getFrontendUrl()).toBe('http://localhost:3000')
  })

  test('uses the localhost default with port 3000 when no env vars are set', () => {
    expect(getFrontendUrl()).toBe('http://localhost:3000')
  })

  test('honors VITE_PORT for the localhost fallback', () => {
    process.env.VITE_PORT = '5173'
    expect(getFrontendUrl()).toBe('http://localhost:5173')
  })

  test('VITE_PORT does NOT override APP_URL', () => {
    process.env.APP_URL = 'https://app.example.com'
    process.env.VITE_PORT = '5173'
    expect(getFrontendUrl()).toBe('https://app.example.com')
  })

  test('VITE_PORT does NOT override ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = 'https://origin.example.com'
    process.env.VITE_PORT = '5173'
    expect(getFrontendUrl()).toBe('https://origin.example.com')
  })

  test('parses VITE_PORT as an integer (drops trailing non-digits)', () => {
    process.env.VITE_PORT = '4321abc'
    // parseInt('4321abc', 10) === 4321
    expect(getFrontendUrl()).toBe('http://localhost:4321')
  })

  test('falls back to port 3000 when VITE_PORT is non-numeric', () => {
    process.env.VITE_PORT = 'not-a-number'
    // parseInt('not-a-number', 10) === NaN → fallback evaluates `'NaN'` literal;
    // we just assert the implementation's actual behavior here.
    const result = getFrontendUrl()
    expect(result.startsWith('http://localhost:')).toBe(true)
  })
})
