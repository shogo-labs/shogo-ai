// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  isPublishMetalAuthoritative,
  missingProjectsDatabaseConfig,
  resolvePublishDbProvider,
  shouldProvisionPublishedDatabase,
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

  describe('shouldProvisionPublishedDatabase', () => {
    it('is off until the cluster is fully configured', () => {
      // Unknown infrastructure must not turn every server-app publish into a 503.
      expect(shouldProvisionPublishedDatabase('knative')).toBe(false)
      expect(missingProjectsDatabaseConfig()).toEqual([
        'PROJECTS_DB_ADMIN_URL',
        'PROJECTS_DB_POOLER_HOST',
      ])
    })

    it('is still off with only the admin URL, because the refusal also needs the pooler', () => {
      process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin@projects-pg-rw:5432/postgres'
      expect(shouldProvisionPublishedDatabase('knative')).toBe(false)
      expect(missingProjectsDatabaseConfig()).toEqual(['PROJECTS_DB_POOLER_HOST'])
    })

    it('is still off with only the pooler host, because provisioning needs the admin URL', () => {
      process.env.PROJECTS_DB_POOLER_HOST = 'projects-pg-pooler-rw.shogo-staging-system.svc.cluster.local'
      expect(shouldProvisionPublishedDatabase('knative')).toBe(false)
      expect(missingProjectsDatabaseConfig()).toEqual(['PROJECTS_DB_ADMIN_URL'])
    })

    it('is on for a Knative publish once both are set', () => {
      process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin@projects-pg-rw:5432/postgres'
      process.env.PROJECTS_DB_POOLER_HOST = 'projects-pg-pooler-rw.shogo-staging-system.svc.cluster.local'
      expect(shouldProvisionPublishedDatabase('knative')).toBe(true)
      expect(missingProjectsDatabaseConfig()).toEqual([])
    })

    it('never provisions a database for a metal publish (SQLite archive stays)', () => {
      process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin@projects-pg-rw:5432/postgres'
      process.env.PROJECTS_DB_POOLER_HOST = 'projects-pg-pooler-rw.shogo-staging-system.svc.cluster.local'
      process.env.PUBLISH_POSTGRES = 'on'
      expect(shouldProvisionPublishedDatabase('metal')).toBe(false)
    })

    it('PUBLISH_POSTGRES=on forces it even without an admin URL, so a bad config fails loudly', () => {
      process.env.PUBLISH_POSTGRES = 'on'
      expect(shouldProvisionPublishedDatabase('knative')).toBe(true)
    })

    it('PUBLISH_POSTGRES=off takes publishes back to SQLite without unsetting the URLs', () => {
      process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin@projects-pg-rw:5432/postgres'
      process.env.PROJECTS_DB_POOLER_HOST = 'projects-pg-pooler-rw.shogo-staging-system.svc.cluster.local'
      process.env.PUBLISH_POSTGRES = 'off'
      expect(shouldProvisionPublishedDatabase('knative')).toBe(false)
    })
  })

  // §G: the region switch now also takes a list of project ids, and an
  // environment that is already on Postgres ignores the switch entirely.
  describe('project-id list form', () => {
    const KIF = '5925615d-0157-44d3-a114-41b35a14785e'
    const NADA = 'c7d51ded-aa79-42a5-8e48-2b10222d743d'
    const OTHER = '0c8a4d79-b3b2-4cfa-b2c1-95418f91d670'

    it('is on only for the projects it lists', () => {
      process.env.PUBLISH_POSTGRES = `${KIF},${NADA}`
      expect(shouldProvisionPublishedDatabase('knative', KIF)).toBe(true)
      expect(shouldProvisionPublishedDatabase('knative', NADA)).toBe(true)
      expect(shouldProvisionPublishedDatabase('knative', OTHER)).toBe(false)
    })

    it('matches a short prefix, which is how the overlay reads', () => {
      process.env.PUBLISH_POSTGRES = '5925615d'
      expect(shouldProvisionPublishedDatabase('knative', KIF)).toBe(true)
      expect(shouldProvisionPublishedDatabase('knative', OTHER)).toBe(false)
    })

    it('a list needs a project to match, so a caller with none stays off', () => {
      process.env.PUBLISH_POSTGRES = KIF
      expect(shouldProvisionPublishedDatabase('knative')).toBe(false)
    })

    it('stays off for metal whatever the list says', () => {
      process.env.PUBLISH_POSTGRES = `${KIF},${NADA}`
      expect(shouldProvisionPublishedDatabase('metal', KIF)).toBe(false)
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
