// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Minimal Latitude.sh API client for bare-metal server lifecycle.
 *
 * We deliberately do NOT manage bare-metal servers in Terraform (see
 * config/metal-fleet.ts): the fleet reconciler provisions/destroys hosts on
 * demand against this API — baseline monthly hosts and short-lived hourly burst
 * hosts. This is the thin, typed HTTP surface the reconciler drives; it holds no
 * scheduling logic itself.
 *
 * Auth: the API token comes from LATITUDESH_AUTH_TOKEN (never committed). When
 * unset, `isConfigured()` is false and the reconciler stays in observe-only mode
 * (it plans but never calls out) — so this is safe to ship disabled.
 *
 * Latitude uses a JSON:API envelope: request/response bodies wrap the resource
 * in `{ data: { type, id, attributes } }`.
 */

const LATITUDE_API = process.env.LATITUDESH_API_URL || 'https://api.latitude.sh'

export interface CreateServerOpts {
  project: string
  plan: string
  site: string
  operatingSystem: string
  hostname: string
  sshKeys: string[]
  billing: 'hourly' | 'monthly' | 'yearly'
  /** Optional cloud-init user_data (base64 or raw per Latitude) to bootstrap the
   * node-agent so a burst host auto-joins the fleet with the right host id. */
  userData?: string
}

export interface LatitudeServer {
  id: string
  hostname: string
  status: string
  primaryIpv4: string | null
  site: string
  plan: string
  billing: string
}

export class LatitudeApiError extends Error {
  readonly code = 'LATITUDE_API_ERROR'
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'LatitudeApiError'
  }
}

type FetchImpl = typeof fetch

/** Map a JSON:API server resource to our flat shape. */
function toServer(data: any): LatitudeServer {
  const a = data?.attributes ?? {}
  const region = a.region
  const site = typeof region === 'object' ? region?.site?.slug ?? region?.site ?? '' : (a.site ?? '')
  const plan = typeof a.plan === 'object' ? a.plan?.slug ?? '' : (a.plan ?? '')
  return {
    id: data?.id,
    hostname: a.hostname ?? '',
    status: a.status ?? '',
    primaryIpv4: a.primary_ipv4 ?? null,
    site: site ?? '',
    plan: plan ?? '',
    billing: a.billing ?? '',
  }
}

export class LatitudeClient {
  private readonly token: string | undefined
  private readonly fetchImpl: FetchImpl
  private readonly timeoutMs: number

  constructor(opts: { token?: string; fetchImpl?: FetchImpl; timeoutMs?: number } = {}) {
    this.token = opts.token ?? process.env.LATITUDESH_AUTH_TOKEN
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  /** True when an API token is present. The reconciler stays observe-only otherwise. */
  isConfigured(): boolean {
    return !!this.token
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new LatitudeApiError('LATITUDESH_AUTH_TOKEN not set', 0)
    const res = await this.fetchImpl(`${LATITUDE_API}${path}`, {
      method,
      headers: {
        Authorization: this.token,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    let json: any = undefined
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        /* non-JSON body (e.g. 204) */
      }
    }
    if (!res.ok) {
      const detail = json?.errors ?? text
      const first = Array.isArray(json?.errors) ? json.errors[0] : undefined
      const msg = first?.detail || first?.title || `Latitude ${method} ${path} failed (${res.status})`
      throw new LatitudeApiError(msg, res.status, detail)
    }
    return json as T
  }

  async createServer(opts: CreateServerOpts): Promise<LatitudeServer> {
    const payload = {
      data: {
        type: 'servers',
        attributes: {
          project: opts.project,
          plan: opts.plan,
          site: opts.site,
          operating_system: opts.operatingSystem,
          hostname: opts.hostname,
          ssh_keys: opts.sshKeys,
          billing: opts.billing,
          ...(opts.userData ? { user_data: opts.userData } : {}),
        },
      },
    }
    const res = await this.request<{ data: any }>('POST', '/servers', payload)
    return toServer(res.data)
  }

  async getServer(serverId: string): Promise<LatitudeServer> {
    const res = await this.request<{ data: any }>('GET', `/servers/${serverId}`)
    return toServer(res.data)
  }

  async listServers(project?: string): Promise<LatitudeServer[]> {
    const q = project ? `?filter[project]=${encodeURIComponent(project)}` : ''
    const res = await this.request<{ data: any[] }>('GET', `/servers${q}`)
    return (res.data ?? []).map(toServer)
  }

  async deleteServer(serverId: string): Promise<void> {
    await this.request<void>('DELETE', `/servers/${serverId}`)
  }
}

let client: LatitudeClient | null = null

export function getLatitudeClient(): LatitudeClient {
  if (!client) client = new LatitudeClient()
  return client
}

/** Test-only: inject a client (e.g. with a fake fetch) or reset. */
export function _setLatitudeClient(c: LatitudeClient | null): void {
  client = c
}
