// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

delete (process.env as any).KUBERNETES_SERVICE_HOST

// SDK isn't built on this branch — stub transitive runtime imports. extraEnv
// is the only RUNTIME_CONFIG field the pure builder reads.
mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: {
    image: () => 'ghcr.io/shogo/runtime:test',
    workDir: '/app/workspace',
    extraEnv: { SHOGO_EXTRA: '1' },
    componentLabel: 'runtime',
    containerName: 'runtime',
  },
}))

// NOTE: `@shogo/model-catalog` is intentionally NOT mocked here. Under
// apps/api's `conditions = ["development"]` it resolves to real source
// (`@shogo-ai/sdk/model-catalog` -> `@shogo-ai/agent/model-catalog`), and the
// knative-workspace-manager import graph (build-workspace-env -> auto-tier-env)
// statically imports `getAutoTierOverrides` / `inferProviderFromModel`. A
// partial mock omits those and breaks the module at link time.

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    loadFromOptions() {}
    makeApiClient() { return {} }
  },
  CustomObjectsApi: class {},
  CoreV1Api: class {},
}))

mock.module('fs', () => ({ existsSync: () => false, readFileSync: () => '' }))

const mod = await import('../knative-workspace-manager')
const { buildKnativeWorkspaceService, workspaceServiceName } = mod

function baseOpts(overrides: Partial<Parameters<typeof buildKnativeWorkspaceService>[0]> = {}) {
  return {
    workspaceId: 'ws-123',
    attachedProjectIds: ['p1', 'p2'],
    env: {
      WORKSPACE_ID: 'ws-123',
      WORKSPACE_RUNTIME: 'true',
      WORKSPACE_PROJECT_IDS: 'p1,p2',
      WORKSPACE_PROJECTS: JSON.stringify([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]),
      RUNTIME_AUTH_SECRET: 'wrt_v1_secret',
      AI_PROXY_URL: 'http://api.local/api/ai/v1',
    },
    namespace: 'shogo-workspaces',
    image: 'ghcr.io/shogo/runtime:test',
    workDir: '/app/workspace',
    componentLabel: 'runtime',
    containerName: 'runtime',
    resourceSpec: { requests: { memory: '768Mi', cpu: '100m' }, limits: { memory: '2Gi', cpu: '1000m' } },
    diskSizeLimit: '4Gi',
    minScale: 1,
    idleTimeoutSeconds: 1800,
    ...overrides,
  }
}

function envByName(svc: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const e of svc.spec.template.spec.containers[0].env) out[e.name] = e
  return out
}

describe('workspaceServiceName', () => {
  it('is workspace-{id}', () => {
    expect(workspaceServiceName('ws-abc')).toBe('workspace-ws-abc')
  })

  it('is workspace-proj-{anchor} when anchored', () => {
    expect(workspaceServiceName('ws-abc', 'proj-9')).toBe('workspace-proj-proj-9')
  })
})

describe('buildKnativeWorkspaceService — metadata', () => {
  it('names the service workspace-{id} with workspace labels', () => {
    const svc = buildKnativeWorkspaceService(baseOpts())
    expect(svc.apiVersion).toBe('serving.knative.dev/v1')
    expect(svc.kind).toBe('Service')
    expect(svc.metadata.name).toBe('workspace-ws-123')
    expect(svc.metadata.namespace).toBe('shogo-workspaces')
    expect(svc.metadata.labels['shogo.io/workspace']).toBe('ws-123')
    expect(svc.metadata.labels['app.kubernetes.io/part-of']).toBe('shogo')
    expect(svc.metadata.labels['shogo.io/component']).toBe('runtime')
    // No anchor → no anchor label.
    expect(svc.metadata.labels['shogo.io/anchor-project']).toBeUndefined()
  })

  it('names the service workspace-proj-{anchor} with an anchor label + anchor env when anchored', () => {
    const svc = buildKnativeWorkspaceService(
      baseOpts({
        anchorProjectId: 'p1',
        env: {
          WORKSPACE_ID: 'ws-123',
          WORKSPACE_RUNTIME: 'true',
          WORKSPACE_PROJECT_IDS: 'p1,p2',
          WORKSPACE_ANCHOR_PROJECT_ID: 'p1',
        },
      }),
    )
    expect(svc.metadata.name).toBe('workspace-proj-p1')
    expect(svc.metadata.labels['shogo.io/anchor-project']).toBe('p1')
    const env = envByName(svc)
    expect(env.WORKSPACE_ANCHOR_PROJECT_ID.value).toBe('p1')
    expect(env.WORKSPACE_PROJECT_IDS.value).toBe('p1,p2')
  })
})

describe('buildKnativeWorkspaceService — merged-root env', () => {
  it('sets WORKSPACE_DIR to the mount path and SCHEMAS_PATH', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts()))
    expect(env.WORKSPACE_DIR.value).toBe('/app/workspace')
    expect(env.SCHEMAS_PATH.value).toBe('/app/.schemas')
  })

  it('passes the workspace env map through (merged-root markers)', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts()))
    expect(env.WORKSPACE_RUNTIME.value).toBe('true')
    expect(env.WORKSPACE_ID.value).toBe('ws-123')
    expect(env.WORKSPACE_PROJECT_IDS.value).toBe('p1,p2')
    expect(env.RUNTIME_AUTH_SECRET.value).toBe('wrt_v1_secret')
  })

  it('includes RUNTIME_CONFIG.extraEnv', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts()))
    expect(env.SHOGO_EXTRA.value).toBe('1')
  })

  it('does not duplicate WORKSPACE_DIR if present in the env map', () => {
    const opts = baseOpts()
    ;(opts.env as any).WORKSPACE_DIR = '/should/be/ignored'
    const svc = buildKnativeWorkspaceService(opts)
    const dirs = svc.spec.template.spec.containers[0].env.filter((e: any) => e.name === 'WORKSPACE_DIR')
    expect(dirs).toHaveLength(1)
    expect(dirs[0].value).toBe('/app/workspace')
  })
})

describe('buildKnativeWorkspaceService — S3 + OTEL secret refs', () => {
  it('omits AWS secret refs when no S3 bucket', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts()))
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  it('adds AWS secret refs when an S3 bucket is configured', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts({ s3Bucket: 'shogo-workspaces' })))
    expect(env.AWS_ACCESS_KEY_ID.valueFrom.secretKeyRef.name).toBe('s3-credentials')
    expect(env.AWS_SECRET_ACCESS_KEY.valueFrom.secretKeyRef.key).toBe('secret-key')
  })

  it('omits OTEL env when no endpoint', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts()))
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
  })

  it('adds OTEL endpoint + SIGNOZ secret ref when configured', () => {
    const env = envByName(buildKnativeWorkspaceService(baseOpts({ otelEndpoint: 'http://signoz:4317' })))
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT.value).toBe('http://signoz:4317')
    expect(env.OTEL_SERVICE_NAME.value).toBe('shogo-runtime')
    expect(env.SIGNOZ_INGESTION_KEY.valueFrom.secretKeyRef.name).toBe('signoz-credentials')
  })
})

describe('buildKnativeWorkspaceService — pod spec', () => {
  it('mounts a single workspace-data emptyDir at the work dir', () => {
    const svc = buildKnativeWorkspaceService(baseOpts())
    const spec = svc.spec.template.spec
    expect(spec.volumes).toHaveLength(1)
    expect(spec.volumes[0].name).toBe('workspace-data')
    expect(spec.volumes[0].emptyDir.sizeLimit).toBe('4Gi')
    const mounts = spec.containers[0].volumeMounts
    expect(mounts).toEqual([{ name: 'workspace-data', mountPath: '/app/workspace' }])
  })

  it('wires resource spec and probes', () => {
    const c = buildKnativeWorkspaceService(baseOpts()).spec.template.spec.containers[0]
    expect(c.resources.limits.memory).toBe('2Gi')
    expect(c.readinessProbe.httpGet.path).toBe('/ready')
    expect(c.livenessProbe.httpGet.path).toBe('/health')
    expect(c.ports[0].containerPort).toBe(8080)
  })

  it('sets autoscaling annotations from minScale + idle timeout', () => {
    const svc = buildKnativeWorkspaceService(baseOpts({ minScale: 0, idleTimeoutSeconds: 600 }))
    const ann = svc.spec.template.metadata.annotations
    expect(ann['autoscaling.knative.dev/min-scale']).toBe('0')
    expect(ann['autoscaling.knative.dev/max-scale']).toBe('1')
    expect(ann['autoscaling.knative.dev/scale-to-zero-pod-retention-period']).toBe('600s')
    expect(ann['autoscaling.knative.dev/target-burst-capacity']).toBe('0')
  })
})
