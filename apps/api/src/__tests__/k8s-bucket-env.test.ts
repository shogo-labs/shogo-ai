// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Every overlay that serves published apps also has a project bucket (SHO-491).
 *
 * `production-eu` shipped setting `PUBLISH_BUCKET`/`PUBLISH_DATA_BUCKET` but not
 * `S3_PROJECT_BUCKET`, so for EU-homed workspaces the bucket API answered
 * `503 bucket_not_configured` and the storage pass reported `bucket` as
 * unmeasured — the feature was simply off in a region nobody had checked. The
 * var is forgotten exactly once per new region unless something pins the
 * invariant, so this reads every overlay instead of relying on the one that was
 * remembered.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseAllDocuments } from 'yaml'

const OVERLAYS = join(import.meta.dir, '../../../../k8s/overlays')

/** Every literal env entry of every container in an overlay's api-service.yaml. */
function envOf(dir: string, file: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const doc of parseAllDocuments(readFileSync(join(OVERLAYS, dir, file), 'utf8'))) {
    const containers = doc.toJS()?.spec?.template?.spec?.containers ?? []
    for (const container of containers) {
      for (const entry of container.env ?? []) {
        if (typeof entry?.value === 'string') env[entry.name] = entry.value
      }
    }
  }
  return env
}

const deployments = readdirSync(OVERLAYS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => {
    try {
      readFileSync(join(OVERLAYS, dir, 'api-service.yaml'))
      return true
    } catch {
      return false
    }
  })
  .map((dir) => ({ dir, env: envOf(dir, 'api-service.yaml') }))

describe('project bucket env across k8s overlays', () => {
  test('an overlay that serves published apps also sets S3_PROJECT_BUCKET', () => {
    const published = deployments.filter((entry) => entry.env.PUBLISH_DATA_BUCKET)
    expect(published.length).toBeGreaterThan(0)
    expect(published.filter((entry) => !entry.env.S3_PROJECT_BUCKET).map((entry) => entry.dir)).toEqual([])
  })

  test('the name is one the object-storage module creates', () => {
    for (const entry of deployments) {
      const name = entry.env.S3_PROJECT_BUCKET
      if (!name) continue
      // terraform/modules/object-storage: shogo-project-buckets-${var.environment}
      expect({ overlay: entry.dir, name }).toEqual({
        overlay: entry.dir,
        name: expect.stringMatching(/^shogo-project-buckets-[a-z0-9-]+$/),
      })
    }
  })
})
