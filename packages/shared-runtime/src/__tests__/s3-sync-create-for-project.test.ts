// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for `createS3SyncForProject` — the per-import factory used by
// the API server to push a freshly-imported project's workspace up to S3.
//
// Why a dedicated factory (vs reusing `createS3SyncFromEnv`)? The API
// process serves many projects, so we cannot derive the prefix from
// `process.env.PROJECT_ID` the way the runtime pod does. Tests here pin:
//
//   - it does NOT read PROJECT_ID from the environment (regression guard),
//   - misconfiguration (missing bucket) returns null instead of crashing,
//   - the resulting S3Sync uses the explicit projectId as its key prefix,
//   - the watcher is disabled (caller is doing a one-shot upload).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createS3SyncForProject } from '../s3-sync'

// Snapshot + restore env so each test runs against a known baseline.
const ENV_KEYS = [
  'S3_WORKSPACES_BUCKET',
  'S3_REGION',
  'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'PROJECT_ID',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
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

describe('createS3SyncForProject', () => {
  test('returns null when S3_WORKSPACES_BUCKET is unset', () => {
    const sync = createS3SyncForProject('/tmp/x', 'proj-abc')
    expect(sync).toBeNull()
  })

  test('returns null when projectId is empty', () => {
    process.env.S3_WORKSPACES_BUCKET = 'some-bucket'
    const sync = createS3SyncForProject('/tmp/x', '')
    expect(sync).toBeNull()
  })

  test('returns an instance with the explicit projectId as prefix', () => {
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-staging'
    process.env.S3_REGION = 'us-ashburn-1'
    // The bug we are explicitly guarding against: previously the factory
    // could leak PROJECT_ID from the environment and stamp the wrong
    // prefix on a per-import S3Sync instance.
    process.env.PROJECT_ID = 'wrong-project-from-env'

    const sync = createS3SyncForProject('/tmp/imports/proj-123', 'proj-123')
    expect(sync).not.toBeNull()
    // Access through the public archive-key helper so we don't reach into
    // private fields and couple this test to S3Sync internals.
    // getProjectArchiveKey returns `${prefix}/project-src.tar.gz`.
    const key = (sync as any)['getProjectArchiveKey']?.() as string | undefined
    expect(key).toBe('proj-123/project-src.tar.gz')
    // Reinforce: the env value was NOT used as the prefix.
    expect(key?.startsWith('wrong-project-from-env')).toBe(false)
  })

  test('disables the file watcher (one-shot upload semantics)', () => {
    process.env.S3_WORKSPACES_BUCKET = 'b'
    const sync = createS3SyncForProject('/tmp/y', 'proj-watch-off') as any
    expect(sync).not.toBeNull()
    // S3Sync stores its resolved config on `this.config`. We only assert
    // the watcher flag; everything else is covered by the env-driven
    // factory's own tests.
    expect(sync.config.watchEnabled).toBe(false)
  })

  test('passes through S3_ENDPOINT for MinIO / OCI compat mode', () => {
    process.env.S3_WORKSPACES_BUCKET = 'b'
    process.env.S3_ENDPOINT = 'https://example.compat.objectstorage.example.com'
    const sync = createS3SyncForProject('/tmp/z', 'proj-endpoint') as any
    expect(sync.config.endpoint).toBe(
      'https://example.compat.objectstorage.example.com',
    )
  })
})
