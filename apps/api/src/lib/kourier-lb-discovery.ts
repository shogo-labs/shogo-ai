// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Kourier LB IP discovery
 *
 * Looks up this cluster's externally-routable Kourier load balancer IP by
 * reading `Service kourier` in namespace `kourier-system`. Used by
 * `cloudflare-dns.ts` when the operator hasn't pinned `KOURIER_LB_IP` via
 * an env var (which is the recommended setup — adding a new region only
 * needs `CF_API_TOKEN` + `CF_ZONE_ID`, never a region-specific IP).
 *
 * The function is deliberately small and isolated so the cloudflare-dns
 * module stays free of `@kubernetes/client-node` and can be unit-tested
 * without any K8s mocks. The discoverer is injected into cloudflare-dns
 * via `_setKourierDiscovererForTest` in tests.
 *
 * Failures are non-fatal: if the kourier-system service is unreachable
 * (e.g., RBAC not granted, kourier not installed, local dev), the helper
 * returns null and the caller falls back to its existing no-op path.
 */

import * as fs from 'fs'
import * as k8s from '@kubernetes/client-node'

const KOURIER_NAMESPACE = process.env.KOURIER_NAMESPACE || 'kourier-system'
const KOURIER_SERVICE = process.env.KOURIER_SERVICE_NAME || 'kourier'

let cachedCoreApi: k8s.CoreV1Api | null = null

function getKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig()
  const serviceAccountDir = '/var/run/secrets/kubernetes.io/serviceaccount'
  const caPath = `${serviceAccountDir}/ca.crt`
  const tokenPath = `${serviceAccountDir}/token`

  if (fs.existsSync(caPath) && fs.existsSync(tokenPath)) {
    const ca = fs.readFileSync(caPath, 'utf8')
    const token = fs.readFileSync(tokenPath, 'utf8')
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
    kc.loadFromOptions({
      clusters: [{ name: 'in-cluster', server: host, caData: Buffer.from(ca).toString('base64') }],
      users: [{ name: 'in-cluster', token }],
      contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
      currentContext: 'in-cluster',
    })
  } else {
    kc.loadFromDefault()
  }
  return kc
}

function getCoreApi(): k8s.CoreV1Api {
  if (!cachedCoreApi) {
    cachedCoreApi = getKubeConfig().makeApiClient(k8s.CoreV1Api)
  }
  return cachedCoreApi
}

/** Reset cached client (for tests). */
export function _resetKourierLbDiscoveryForTest(): void {
  cachedCoreApi = null
}

/**
 * Read the Kourier load balancer service and return its first external IP,
 * or null if the service has no LB ingress yet (which is expected on
 * staging/local where kourier doesn't run, and for the brief window between
 * cluster provision and OCI assigning an LB IP).
 *
 * Throws on K8s API errors (RBAC denial, network failure, etc.) so callers
 * can distinguish "not ready yet" (null) from "we can't even ask" (throw).
 */
export async function discoverKourierLbIp(): Promise<string | null> {
  const api = getCoreApi()
  const resp = await api.readNamespacedService({
    name: KOURIER_SERVICE,
    namespace: KOURIER_NAMESPACE,
  })
  const ingress = resp.status?.loadBalancer?.ingress ?? []
  for (const i of ingress) {
    if (i.ip) return i.ip
    // Some clouds expose only hostname (e.g. AWS ELB). The CF DNS helper
    // wants an A record, not CNAME — bail rather than silently use a
    // hostname that would be interpreted as a literal IP downstream.
    if (i.hostname) {
      throw new Error(
        `Kourier LB has hostname-only ingress (${i.hostname}); cloudflare-dns.ts requires an IPv4 address`,
      )
    }
  }
  return null
}
