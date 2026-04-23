// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the `shogo-client` generator.
 *
 * Run: bun test packages/sdk/src/generators/__tests__/shogo-client-generator.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { generateShogoClient } from '../shogo-client-generator'

describe('generateShogoClient', () => {
  test('default output: reads PROJECT_ID from env, imports prisma from ./db', () => {
    const { fileName, code } = generateShogoClient()
    expect(fileName).toBe('shogo.ts')
    expect(code).toContain("import { createClient } from '@shogo-ai/sdk'")
    expect(code).toContain("import { prisma } from './db'")
    expect(code).toContain("process.env.PROJECT_ID")
    expect(code).toContain("process.env.SHOGO_API_URL")
    // Must NOT embed a literal projectId — every pod gets a different one.
    expect(code).not.toMatch(/projectId: '[a-z0-9_-]{8,}'/i)
    // Must NOT embed an API key.
    expect(code).not.toMatch(/shogo_sk_/)
    expect(code).not.toMatch(/RUNTIME_AUTH_SECRET\s*=/)
  })

  test('custom dbImportPath', () => {
    const { code } = generateShogoClient({ dbImportPath: '../infra/prisma' })
    expect(code).toContain("import { prisma } from '../infra/prisma'")
  })

  test('custom defaultApiUrl is used as a fallback string', () => {
    const { code } = generateShogoClient({
      defaultApiUrl: 'https://api.shogo.ai',
    })
    expect(code).toContain("process.env.SHOGO_API_URL ?? 'https://api.shogo.ai'")
  })

  test('fileExtension: tsx', () => {
    const { fileName } = generateShogoClient({ fileExtension: 'tsx' })
    expect(fileName).toBe('shogo.tsx')
  })

  test('production guard: throws when PROJECT_ID missing in prod', () => {
    const { code } = generateShogoClient()
    expect(code).toContain("process.env.NODE_ENV === 'production'")
    expect(code).toContain('PROJECT_ID is not set')
  })

  test('includes SPDX license header', () => {
    const { code } = generateShogoClient()
    expect(code).toMatch(/SPDX-License-Identifier/)
  })

  test('re-exports PROJECT_ID and shogo singleton', () => {
    const { code } = generateShogoClient()
    expect(code).toContain('export const PROJECT_ID')
    expect(code).toContain('export const shogo')
    expect(code).toContain('export type ShogoClient')
  })
})
