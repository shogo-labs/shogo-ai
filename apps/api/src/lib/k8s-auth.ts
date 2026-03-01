/**
 * Kubernetes ServiceAccount Token Authentication
 *
 * Validates K8s ServiceAccount tokens using the TokenReview API.
 * Used to authenticate internal API calls from runtime pods.
 */

import * as k8s from '@kubernetes/client-node'

const NAMESPACE = process.env.PROJECT_NAMESPACE || 'shogo-workspaces'

let authApi: k8s.AuthenticationV1Api | null = null
let customApi: k8s.CustomObjectsApi | null = null

function getKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig()
  const serviceAccountDir = '/var/run/secrets/kubernetes.io/serviceaccount'
  const caPath = `${serviceAccountDir}/ca.crt`
  const tokenPath = `${serviceAccountDir}/token`

  if (
    require('fs').existsSync(caPath) &&
    require('fs').existsSync(tokenPath)
  ) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const token = require('fs').readFileSync(tokenPath, 'utf8')
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
    kc.loadFromOptions({
      clusters: [{ name: 'in-cluster', server: host, skipTLSVerify: true }],
      users: [{ name: 'in-cluster', token }],
      contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
      currentContext: 'in-cluster',
    })
  } else {
    kc.loadFromDefault()
  }
  return kc
}

function getAuthApi(): k8s.AuthenticationV1Api {
  if (!authApi) {
    const kc = getKubeConfig()
    authApi = kc.makeApiClient(k8s.AuthenticationV1Api)
  }
  return authApi
}

function getCustomApi(): k8s.CustomObjectsApi {
  if (!customApi) {
    const kc = getKubeConfig()
    customApi = kc.makeApiClient(k8s.CustomObjectsApi)
  }
  return customApi
}

export interface PodIdentity {
  namespace: string
  serviceAccountName: string
  podName: string
  uid: string
}

/**
 * Validate a K8s ServiceAccount token via the TokenReview API.
 * Returns the pod identity if valid and in the expected namespace.
 */
export async function validatePodToken(token: string): Promise<PodIdentity | null> {
  try {
    const api = getAuthApi()
    const review: k8s.V1TokenReview = {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: { token },
    }

    const result = await api.createTokenReview({ body: review })
    const status = result.status

    if (!status?.authenticated) {
      console.log('[K8sAuth] Token not authenticated')
      return null
    }

    const username = status.user?.username || ''
    // SA tokens have format: system:serviceaccount:{namespace}:{name}
    const parts = username.split(':')
    if (parts.length < 4 || parts[0] !== 'system' || parts[1] !== 'serviceaccount') {
      console.log(`[K8sAuth] Not a service account token: ${username}`)
      return null
    }

    const namespace = parts[2]
    const serviceAccountName = parts[3]

    if (namespace !== NAMESPACE) {
      console.log(`[K8sAuth] Token from wrong namespace: ${namespace} (expected ${NAMESPACE})`)
      return null
    }

    return {
      namespace,
      serviceAccountName,
      podName: serviceAccountName,
      uid: status.user?.uid || '',
    }
  } catch (err: any) {
    console.error('[K8sAuth] TokenReview failed:', err.message)
    return null
  }
}

/**
 * Verify that a Knative Service has the expected assigned-project annotation.
 * Prevents a pod from fetching config for a project it isn't assigned to.
 */
export async function verifyServiceAssignment(
  serviceName: string,
  expectedProjectId: string
): Promise<boolean> {
  try {
    const api = getCustomApi()
    const response = await api.getNamespacedCustomObject({
      group: 'serving.knative.dev',
      version: 'v1',
      namespace: NAMESPACE,
      plural: 'services',
      name: serviceName,
    })

    const service = response as any
    const annotations = service.metadata?.annotations || {}
    const assignedProject = annotations['shogo.io/assigned-project']

    if (assignedProject !== expectedProjectId) {
      console.log(
        `[K8sAuth] Service ${serviceName} annotation mismatch: ` +
        `expected ${expectedProjectId}, got ${assignedProject}`
      )
      return false
    }

    return true
  } catch (err: any) {
    console.error(`[K8sAuth] Failed to verify service assignment for ${serviceName}:`, err.message)
    return false
  }
}
