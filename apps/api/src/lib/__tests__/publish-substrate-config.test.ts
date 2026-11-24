// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  isPublishMetalAuthoritative,
  missingProjectsDatabaseConfig,
  resolvePublishDbProvider,
  shouldServeStaticFromEdgeOnly,
} from '../publish-substrate-config'

const ENV_KEYS = [
  'PUBLISH_SUBSTRATE',
  'SHOGO_METAL_ENABLED',
  'SHOGO_METAL_ALL_PROJECTS',
  'SHOGO_METAL_DRAIN_MODE',
  'PUBLISH_STATIC_KSVC',
  'PUBLISH_POSTGRES',
  'PROJECTS_DB_ADMIN_URL',
  'PROJECTS_DB_POOLER_HOST',
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

  describe('resolvePublishDbProvider', () => {
    const KIF = '5925615d-0157-44d3-a114-41b35a14785e'

    it('keeps an environment that is on Postgres there with PUBLISH_POSTGRES=off', () => {
      // The §G1 failure: a SQLite image built against a Postgres DATABASE_URL
      // fails the boot guard and the site never serves again.
      process.env.PUBLISH_POSTGRES = 'off'
      expect(
        resolvePublishDbProvider({
          serverBacked: true,
          substrateKind: 'knative',
          environmentProvider: 'postgres',
          projectId: KIF,
        }),
      ).toEqual({ provider: 'postgres', reason: 'sticky' })
    })

    it('leaves a SQLite environment on SQLite when the flag is off', () => {
      process.env.PUBLISH_POSTGRES = 'off'
      expect(
        resolvePublishDbProvider({
          serverBacked: true,
          substrateKind: 'knative',
          environmentProvider: 'sqlite',
          projectId: KIF,
        }),
      ).toEqual({ provider: 'sqlite', reason: 'off' })
    })

    it('moves only a listed project', () => {
      process.env.PUBLISH_POSTGRES = KIF
      expect(
        resolvePublishDbProvider({ serverBacked: true, substrateKind: 'knative', environmentProvider: null, projectId: KIF }),
      ).toEqual({ provider: 'postgres', reason: 'flag' })
      expect(
        resolvePublishDbProvider({
          serverBacked: true,
          substrateKind: 'knative',
          environmentProvider: null,
          projectId: '0c8a4d79-b3b2-4cfa-b2c1-95418f91d670',
        }),
      ).toEqual({ provider: 'sqlite', reason: 'off' })
    })

    it('falls back to the cluster configuration when the flag has no opinion', () => {
      process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin@projects-pg-rw:5432/postgres'
      process.env.PROJECTS_DB_POOLER_HOST = 'projects-pg-pooler-rw.svc.cluster.local'
      expect(
        resolvePublishDbProvider({ serverBacked: true, substrateKind: 'knative', environmentProvider: null, projectId: KIF }),
      ).toEqual({ provider: 'postgres', reason: 'config' })
    })

    it('never moves a metal site or a static app', () => {
      process.env.PUBLISH_POSTGRES = 'on'
      expect(
        resolvePublishDbProvider({ serverBacked: true, substrateKind: 'metal', environmentProvider: null }),
      ).toEqual({ provider: 'sqlite', reason: 'metal' })
      expect(
        resolvePublishDbProvider({ serverBacked: false, substrateKind: 'knative', environmentProvider: null }),
      ).toEqual({ provider: 'sqlite', reason: 'not-server-backed' })
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
