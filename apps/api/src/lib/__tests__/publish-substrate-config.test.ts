// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  isPublishMetalAuthoritative,
  shouldServeStaticFromEdgeOnly,
} from '../publish-substrate-config'

const ENV_KEYS = [
  'PUBLISH_SUBSTRATE',
  'SHOGO_METAL_ENABLED',
  'SHOGO_METAL_ALL_PROJECTS',
  'SHOGO_METAL_DRAIN_MODE',
  'PUBLISH_STATIC_KSVC',
] as const

describe('publish-substrate-config', () => {
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

  describe('isPublishMetalAuthoritative', () => {
    it('defaults to Knative when nothing is set', () => {
      expect(isPublishMetalAuthoritative()).toBe(false)
    })

    it('stays Knative when the metal fleet is enabled (metal is dev-only)', () => {
      process.env.SHOGO_METAL_ENABLED = 'true'
      expect(isPublishMetalAuthoritative()).toBe(false)
    })

    it('stays Knative under metal-only / drain modes', () => {
      process.env.SHOGO_METAL_ALL_PROJECTS = 'true'
      expect(isPublishMetalAuthoritative()).toBe(false)
    })

    it('PUBLISH_SUBSTRATE=metal forces metal (escape hatch / rollback)', () => {
      process.env.PUBLISH_SUBSTRATE = 'metal'
      expect(isPublishMetalAuthoritative()).toBe(true)
    })

    it('PUBLISH_SUBSTRATE=knative is explicit Knative', () => {
      process.env.SHOGO_METAL_ENABLED = 'true'
      process.env.PUBLISH_SUBSTRATE = 'knative'
      expect(isPublishMetalAuthoritative()).toBe(false)
    })

    it('ignores an unknown PUBLISH_SUBSTRATE value (stays Knative)', () => {
      process.env.PUBLISH_SUBSTRATE = 'nonsense'
      expect(isPublishMetalAuthoritative()).toBe(false)
      process.env.SHOGO_METAL_ENABLED = 'true'
      expect(isPublishMetalAuthoritative()).toBe(false)
    })
  })

  describe('shouldServeStaticFromEdgeOnly', () => {
    it('is edge-only by default', () => {
      expect(shouldServeStaticFromEdgeOnly()).toBe(true)
    })

    it('restores the legacy nginx ksvc when PUBLISH_STATIC_KSVC=true', () => {
      process.env.PUBLISH_STATIC_KSVC = 'true'
      expect(shouldServeStaticFromEdgeOnly()).toBe(false)
    })
  })
})
