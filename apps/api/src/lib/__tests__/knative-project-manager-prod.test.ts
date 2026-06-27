// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Companion file: exercises the PRODUCTION branch of getPreviewSubdomain.
// Bun isolates per file, so PREVIEW_ENVIRONMENT=production is captured
// at module load without contaminating the dev test file.

import { describe, expect, it, mock } from 'bun:test'

process.env.PREVIEW_BASE_DOMAIN = 'shogo.ai'
process.env.PREVIEW_ENVIRONMENT = 'production'

mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: new Proxy({}, { get: () => () => 'stub' }),
}))

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromDefault() {} loadFromOptions() {} makeApiClient() { return {} } getCurrentCluster() { return null } getCurrentUser() { return null } },
  CustomObjectsApi: class {},
  CoreV1Api: class {},
  AuthenticationV1Api: class {},
  AppsV1Api: class {},
  V1Job: class {},
  KubernetesObjectApi: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}))

mock.module('fs', () => ({ existsSync: () => false, readFileSync: () => '' }))

const km = await import('../knative-project-manager')

describe('getPreviewSubdomain — production branch', () => {
  it('omits the env segment when PREVIEW_ENVIRONMENT=production', () => {
    expect(km.getPreviewSubdomain('proj-prod')).toBe('proj-prod.preview.shogo.ai')
    expect(km.getPreviewUrl('proj-prod')).toBe('https://proj-prod.preview.shogo.ai')
  })
})
