// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { getRuntimeApiUrl, getRuntimeAppEnv, getRuntimeAppVersion } from '../runtime-env'

const originalAppEnv = process.env.EXPO_PUBLIC_APP_ENV
const originalApiUrl = process.env.EXPO_PUBLIC_API_URL
const originalAppVersion = process.env.EXPO_PUBLIC_APP_VERSION

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  globalThis.__SHOGO_ENV__ = undefined
  restore('EXPO_PUBLIC_APP_ENV', originalAppEnv)
  restore('EXPO_PUBLIC_API_URL', originalApiUrl)
  restore('EXPO_PUBLIC_APP_VERSION', originalAppVersion)
})

describe('getRuntimeAppVersion', () => {
  test('a promoted image reports the release it is serving, not the version it was built with', () => {
    process.env.EXPO_PUBLIC_APP_VERSION = '1.14.1'
    globalThis.__SHOGO_ENV__ = { appVersion: '1.14.2' }
    expect(getRuntimeAppVersion()).toBe('1.14.2')
  })

  test('falls back to the build-time version', () => {
    process.env.EXPO_PUBLIC_APP_VERSION = '1.14.1'
    expect(getRuntimeAppVersion()).toBe('1.14.1')
  })
})

describe('getRuntimeAppEnv', () => {
  test('prefers the container-injected value over the build-time one', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'staging_web'
    globalThis.__SHOGO_ENV__ = { appEnv: 'production_web' }
    expect(getRuntimeAppEnv()).toBe('production_web')
  })

  test('falls back to the build-time value when nothing was injected', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'production_app'
    expect(getRuntimeAppEnv()).toBe('production_app')
  })

  test('treats an empty injected value as unset', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'staging_app'
    globalThis.__SHOGO_ENV__ = { appEnv: '' }
    expect(getRuntimeAppEnv()).toBe('staging_app')
  })

  test('defaults to development', () => {
    delete process.env.EXPO_PUBLIC_APP_ENV
    expect(getRuntimeAppEnv()).toBe('development')
  })
})

describe('getRuntimeApiUrl', () => {
  test('prefers the container-injected value', () => {
    process.env.EXPO_PUBLIC_API_URL = 'https://studio.staging.shogo.ai'
    globalThis.__SHOGO_ENV__ = { apiUrl: 'https://studio.shogo.ai' }
    expect(getRuntimeApiUrl()).toBe('https://studio.shogo.ai')
  })

  test('is undefined when neither source is set, so web uses its own origin', () => {
    delete process.env.EXPO_PUBLIC_API_URL
    globalThis.__SHOGO_ENV__ = { apiUrl: '' }
    expect(getRuntimeApiUrl()).toBeUndefined()
  })

  test('falls back to the build-time value', () => {
    process.env.EXPO_PUBLIC_API_URL = 'http://localhost:3333'
    expect(getRuntimeApiUrl()).toBe('http://localhost:3333')
  })
})
