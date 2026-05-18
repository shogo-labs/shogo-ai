// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, afterEach } from 'bun:test'
import {
  MCP_CATALOG,
  getCatalogEntry,
  getPreinstalledPackages,
  isPreinstalledMcpId,
  isMcpServerAllowed,
  isCatalogEntry,
  getPreinstalledEntry,
  getCatalogByCategory,
} from '../mcp-catalog'

describe('mcp-catalog', () => {
  const origLocal = process.env.SHOGO_LOCAL_MODE

  afterEach(() => {
    if (origLocal === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = origLocal
  })

  test('catalog has at least one entry and lookups by id work', () => {
    expect(MCP_CATALOG.length).toBeGreaterThan(0)
    const first = MCP_CATALOG[0]
    expect(getCatalogEntry(first.id)?.id).toBe(first.id)
    expect(getCatalogEntry('___nope___')).toBeUndefined()
  })

  test('isCatalogEntry mirrors the catalog membership', () => {
    expect(isCatalogEntry(MCP_CATALOG[0].id)).toBe(true)
    expect(isCatalogEntry('___nope___')).toBe(false)
  })

  test('getPreinstalledPackages returns only entries flagged preinstalled', () => {
    const list = getPreinstalledPackages()
    expect(list.every((e) => e.preinstalled === true)).toBe(true)
  })

  test('isPreinstalledMcpId and getPreinstalledEntry agree on preinstalled status', () => {
    const pre = getPreinstalledPackages()[0]
    if (pre) {
      expect(isPreinstalledMcpId(pre.id)).toBe(true)
      expect(getPreinstalledEntry(pre.id)?.id).toBe(pre.id)
    }
    expect(isPreinstalledMcpId('___nope___')).toBe(false)
    expect(getPreinstalledEntry('___nope___')).toBeUndefined()
  })

  test('isMcpServerAllowed allows anything in local mode and gates by catalog otherwise', () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    expect(isMcpServerAllowed('any-random-pkg')).toBe(true)

    process.env.SHOGO_LOCAL_MODE = 'false'
    expect(isMcpServerAllowed(MCP_CATALOG[0].id)).toBe(true)
    expect(isMcpServerAllowed('___nope___')).toBe(false)
  })

  test('getCatalogByCategory filters entries by category', () => {
    const sample = MCP_CATALOG[0]
    const list = getCatalogByCategory(sample.category)
    expect(list.every((e) => e.category === sample.category)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
  })
})
