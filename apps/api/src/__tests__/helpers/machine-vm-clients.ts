// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — the clients the machine parity checks read with: a session, the
 * SDK's HTTP client, and the cloud app's machine view (the production
 * interceptor). No Bun APIs, so the Playwright staging variant can use them too.
 */
import { HttpClient } from '@shogo-ai/sdk'
import {
  createRemoteAwareHttpClient,
  type RemoteInterceptorConfig,
} from '../../../../../packages/shared-app/src/services/remote-http-interceptor'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A cookie-carrying session against one API, the way the app holds one. */
export interface Session {
  base: string
  cookie: string
  userId: string
}

export async function signUp(base: string, label: string): Promise<Session> {
  const suffix = Math.random().toString(36).slice(2, 8)
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${label}-${suffix}@shogo.test`, password: `Shogo-257-${suffix}-pw`, name: label }),
  })
  if (!res.ok) throw new Error(`sign-up failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const json: any = await res.json()
  return { base, cookie, userId: json?.user?.id }
}

export async function sessionUserId(base: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/get-session`, { headers: { cookie, origin: base } })
  const json: any = await res.json().catch(() => null)
  return json?.user?.id ?? json?.session?.userId
}

/** The SDK's own HTTP client, holding a session cookie. */
export function httpClient(base: string, cookie: string): HttpClient {
  return new HttpClient({ baseUrl: base, getToken: () => null, getAuthCookie: () => cookie })
}

/**
 * The client the cloud app uses while a paired machine's workspace is open:
 * the production interceptor (`createRemoteAwareHttpClient`) wrapping the SDK
 * client, configured exactly as `useActiveInstance` configures it. Every read
 * and write the suite makes through it is routed by the product's own rules —
 * copy for reads, the relay for writes and live reads.
 */
export function machineViewClient(cloud: Session, machineId: string, localWorkspaceId: string): HttpClient {
  const config: RemoteInterceptorConfig = {
    remoteProxyBaseUrl: `${cloud.base}/api/machines/${machineId}/w/${localWorkspaceId}`,
    machineWorkspaceId: localWorkspaceId,
  }
  return createRemoteAwareHttpClient(httpClient(cloud.base, cloud.cookie), () => config)
}

/** GET and return `{ status, data }` without throwing, so a failure names its surface. */
export async function read(client: HttpClient, path: string): Promise<{ status: number; data: any; error?: string }> {
  try {
    const res: any = await client.get(path)
    return { status: res.status ?? 200, data: res.data }
  } catch (err: any) {
    return { status: err?.status ?? 0, data: err?.details ?? null, error: err?.message ?? String(err) }
  }
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (err) {
      last = err
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
