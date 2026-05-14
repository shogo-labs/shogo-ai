// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Reusable stub for `@kubernetes/client-node`.
 *
 * `apps/api/src/lib/knative-project-manager.ts` and the warm-pool
 * controllers both construct several API client classes from this
 * package (CoreV1Api, AppsV1Api, CustomObjectsApi, ...). Mocking the
 * whole package with `mock.module()` requires returning a constructor
 * for every name the source touches, otherwise bun's ESM loader throws
 * `Export named 'X' not found in module '@kubernetes/client-node'`.
 *
 * Pass `withK8sExports({ ... })` to `mock.module('@kubernetes/client-node', ...)`.
 * Every API client class is replaced with a stub that exposes the
 * methods called by the source. Tests can override any individual
 * method by passing it in the options.
 */

export interface K8sStubOptions {
  /** Overrides for CoreV1Api methods. Unspecified methods return `{ body: <empty list> }`. */
  CoreV1Api?: Record<string, (...args: any[]) => any>
  AppsV1Api?: Record<string, (...args: any[]) => any>
  BatchV1Api?: Record<string, (...args: any[]) => any>
  NetworkingV1Api?: Record<string, (...args: any[]) => any>
  CustomObjectsApi?: Record<string, (...args: any[]) => any>
  RbacAuthorizationV1Api?: Record<string, (...args: any[]) => any>
  AuthenticationV1Api?: Record<string, (...args: any[]) => any>
  /** Initial list responses keyed by `${api}.${listMethod}`. */
  listResponses?: Record<string, any>
  /** Capture record for all mutating calls (create / patch / replace / delete). */
  capture?: K8sCallLog
}

export type K8sCallLog = { api: string; method: string; args: any[] }[]

const STANDARD_NOOP_METHODS = {
  CoreV1Api: [
    'listPodForAllNamespaces', 'listNamespacedPod', 'readNamespacedPod', 'createNamespacedPod',
    'deleteNamespacedPod', 'patchNamespacedPod', 'replaceNamespacedPod',
    'listNamespace', 'readNamespace', 'createNamespace', 'deleteNamespace',
    'listNamespacedService', 'readNamespacedService', 'createNamespacedService',
    'deleteNamespacedService', 'patchNamespacedService',
    'listNamespacedConfigMap', 'readNamespacedConfigMap', 'createNamespacedConfigMap',
    'replaceNamespacedConfigMap', 'patchNamespacedConfigMap', 'deleteNamespacedConfigMap',
    'listNamespacedSecret', 'readNamespacedSecret', 'createNamespacedSecret',
    'replaceNamespacedSecret', 'patchNamespacedSecret', 'deleteNamespacedSecret',
    'listNamespacedPersistentVolumeClaim', 'readNamespacedPersistentVolumeClaim',
    'createNamespacedPersistentVolumeClaim', 'deleteNamespacedPersistentVolumeClaim',
    'patchNamespacedPersistentVolumeClaim',
    'readNamespacedPodLog',
    'listNamespacedEvent', 'listNamespacedServiceAccount',
    'createNamespacedServiceAccount', 'readNamespacedServiceAccount',
    'deleteNamespacedServiceAccount',
    'createNamespacedServiceAccountToken',
  ],
  AppsV1Api: [
    'listNamespacedDeployment', 'readNamespacedDeployment', 'createNamespacedDeployment',
    'replaceNamespacedDeployment', 'patchNamespacedDeployment', 'deleteNamespacedDeployment',
    'listNamespacedStatefulSet', 'readNamespacedStatefulSet', 'createNamespacedStatefulSet',
    'replaceNamespacedStatefulSet', 'patchNamespacedStatefulSet', 'deleteNamespacedStatefulSet',
    'listNamespacedReplicaSet',
  ],
  BatchV1Api: [
    'listNamespacedJob', 'readNamespacedJob', 'createNamespacedJob',
    'deleteNamespacedJob', 'patchNamespacedJob',
  ],
  NetworkingV1Api: [
    'listNamespacedIngress', 'readNamespacedIngress', 'createNamespacedIngress',
    'replaceNamespacedIngress', 'patchNamespacedIngress', 'deleteNamespacedIngress',
  ],
  CustomObjectsApi: [
    'listNamespacedCustomObject', 'getNamespacedCustomObject',
    'createNamespacedCustomObject', 'replaceNamespacedCustomObject',
    'patchNamespacedCustomObject', 'deleteNamespacedCustomObject',
    'listClusterCustomObject', 'getClusterCustomObject',
    'createClusterCustomObject', 'patchClusterCustomObject', 'deleteClusterCustomObject',
  ],
  RbacAuthorizationV1Api: [
    'createNamespacedRoleBinding', 'readNamespacedRoleBinding', 'deleteNamespacedRoleBinding',
  ],
  AuthenticationV1Api: [
    'createTokenReview',
  ],
} as const

type ApiName = keyof typeof STANDARD_NOOP_METHODS

function emptyListResponse(method: string): any {
  if (method.startsWith('list')) return { body: { items: [] }, items: [] }
  if (method.startsWith('read') || method.startsWith('get')) {
    return { body: {}, metadata: {}, spec: {}, status: {} }
  }
  return { body: {} }
}

function buildApiClass(name: ApiName, opts: K8sStubOptions): new () => any {
  const overrides = opts[name] ?? {}
  const methods = STANDARD_NOOP_METHODS[name]
  const capture = opts.capture
  const listResponses = opts.listResponses ?? {}
  return class StubApi {
    constructor() {
      for (const m of methods) {
        ;(this as any)[m] = async (...args: any[]) => {
          if (capture) capture.push({ api: name, method: m, args })
          if (overrides[m]) return overrides[m](...args)
          const lookupKey = `${name}.${m}`
          if (listResponses[lookupKey] !== undefined) return listResponses[lookupKey]
          return emptyListResponse(m)
        }
      }
      // Generic method passthrough — some source paths use bracket
      // access. Make any undefined method resolve to a noop list.
      return new Proxy(this, {
        get(target, prop: string) {
          const existing = (target as any)[prop]
          if (existing !== undefined) return existing
          if (prop === 'then') return undefined
          if (typeof prop === 'string' && prop.startsWith('_')) return undefined
          return async (...args: any[]) => {
            if (capture) capture.push({ api: name, method: prop, args })
            return emptyListResponse(prop)
          }
        },
      })
    }
  }
}

/**
 * Build a `mock.module('@kubernetes/client-node', ...)` factory result.
 */
export function withK8sExports(opts: K8sStubOptions = {}): Record<string, any> {
  const apiNames: ApiName[] = [
    'CoreV1Api', 'AppsV1Api', 'BatchV1Api', 'NetworkingV1Api',
    'CustomObjectsApi', 'RbacAuthorizationV1Api', 'AuthenticationV1Api',
  ]
  const out: Record<string, any> = {}
  for (const name of apiNames) {
    out[name] = buildApiClass(name, opts)
  }
  // KubeConfig: the bit of state every client-construction path goes
  // through. Source code typically: new KubeConfig() -> loadFrom* ->
  // makeApiClient(CoreV1Api). We stub it to return the matching
  // class from above.
  out.KubeConfig = class StubKubeConfig {
    loadFromDefault() {}
    loadFromCluster() {}
    loadFromFile() {}
    loadFromOptions() {}
    loadFromString() {}
    setCurrentContext() {}
    getCurrentContext() { return 'stub-context' }
    getCurrentCluster() { return { name: 'stub', server: 'https://stub' } }
    getCurrentUser() { return { name: 'stub-user' } }
    makeApiClient(cls: any) {
      // The caller wants an instance of one of our stub classes; we
      // already constructed those via `buildApiClass`. Just `new` it.
      return new cls()
    }
    applyToHTTPSOptions() {}
    applyToFetchOptions() { return {} }
    applyToRequest() {}
    exportConfig() { return JSON.stringify({}) }
  }
  // Watch: source uses this to follow pod state. Return an object
  // that resolves once with an empty stream. Tests that need event
  // emission can override via opts.
  out.Watch = class StubWatch {
    constructor(_: any) {}
    async watch(_path: string, _query: any, _onEvent: (...args: any[]) => void, _onDone: (...args: any[]) => void) {
      return { abort: () => {} }
    }
  }
  // KubernetesObjectApi is occasionally used for `patch` semantics.
  out.KubernetesObjectApi = class StubObjectApi {
    static makeApiClient(_kc: any) { return new this() }
    async create() { return { body: {} } }
    async patch() { return { body: {} } }
    async read() { return { body: {} } }
    async list() { return { body: { items: [] } } }
    async replace() { return { body: {} } }
    async delete() { return { body: {} } }
  }
  // Common helper types/constants. Plain objects are fine — no source
  // does an `instanceof` against these.
  out.PatchUtils = { PATCH_FORMAT_JSON_PATCH: 'application/json-patch+json' }
  out.HttpError = class HttpError extends Error {
    statusCode: number
    body?: any
    constructor(statusCode = 500, body?: any) {
      super(`k8s http ${statusCode}`)
      this.statusCode = statusCode
      this.body = body
    }
  }
  out.ApiException = class ApiException extends Error {
    code: number
    body: any
    constructor(code = 500, body: any = {}) {
      super(`k8s api ${code}`)
      this.code = code
      this.body = body
    }
  }
  return out
}
