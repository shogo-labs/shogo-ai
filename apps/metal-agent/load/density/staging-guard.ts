// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The soak's staging-only interlock.
 *
 * A density soak deliberately drives a host to its knees: it fills RAM, spins
 * every vCPU, and can OOM-kill guests. Running it against a production host
 * would take real projects down, so the runner refuses to start unless it can
 * prove three things:
 *
 *   1. the host it is about to fill is one of the named staging hosts,
 *   2. the control plane that host heartbeats to is a staging control plane,
 *   3. that control plane's own registry lists the host as live.
 *
 * (3) is the one that catches the case the plan warns about: a host whose name
 * looks like staging but which is registered to prod. The fleet endpoint is the
 * same one the rootfs release gate reads, and it is authenticated with the
 * host's own register token — no super-admin session needed.
 *
 * Pure apart from the injected `fetchFleet`, so a fake fleet response is a unit
 * test.
 */

export interface FleetHost {
  hostId: string
  live?: boolean
  region?: string
}

export interface StagingGuardInput {
  hostId: string
  controlPlaneUrl: string
  region?: string
  /** Host ids the soak may target. `DENSITY_SOAK_STAGING_HOSTS`. */
  allowHosts: string[]
  /** Control-plane hostnames that count as staging. `DENSITY_SOAK_STAGING_CONTROL_PLANES`. */
  allowControlPlaneHosts: string[]
  /** Bearer for the fleet endpoint (the host's METAL_REGISTER_TOKEN). */
  token?: string
  /** Injected for tests; defaults to a real fetch of `/api/internal/metal/fleet`. */
  fetchFleet?: (url: string, token: string) => Promise<{ ok: boolean; hosts?: FleetHost[]; error?: string }>
}

export interface StagingGuardResult {
  ok: boolean
  reasons: string[]
  /** The host id as the control plane's registry reports it, when confirmed. */
  registeredHostId?: string
}

export const DEFAULT_STAGING_HOSTS = ['latitude-dal-1']
/**
 * The staging control plane answers on the staging kourier LB's sslip.io alias
 * (`terraform/environments/staging/main.tf` → `staging_kourier_lb_ip`), which is
 * what the live host actually heartbeats to. Without it the guard rejects the
 * real staging host and the only way through is a manual allow-list override —
 * i.e. it would protect nothing.
 */
export const DEFAULT_STAGING_CONTROL_PLANES = [
  'api-staging.shogo.ai',
  'staging.shogo.ai',
  '*.staging.shogo.ai',
  'api.141.148.27.1.sslip.io',
]

/** Hostnames that are production, whatever else is configured. */
const PROD_CONTROL_PLANES = ['api.shogo.ai', 'shogo.ai', 'studio.shogo.ai']

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function matchesAllowList(hostname: string, allow: string[]): boolean {
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase()
    if (!e) return false
    if (e.startsWith('*.')) return hostname === e.slice(2) || hostname.endsWith(e.slice(1))
    return hostname === e
  })
}

async function defaultFetchFleet(url: string, token: string): Promise<{ ok: boolean; hosts?: FleetHost[]; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; hosts?: FleetHost[]; error?: string } | null
    if (!res.ok || !body?.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` }
    return { ok: true, hosts: body.hosts ?? [] }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

/**
 * Check the three conditions. Never throws: the caller prints `reasons` and
 * exits non-zero, so a refusal always says exactly what was wrong.
 */
export async function assertStagingHost(input: StagingGuardInput): Promise<StagingGuardResult> {
  const reasons: string[] = []

  if (!input.hostId) reasons.push('no host id (pass --host or set METAL_HOST_ID)')
  else if (!input.allowHosts.includes(input.hostId)) {
    reasons.push(`host "${input.hostId}" is not in the staging allow-list [${input.allowHosts.join(', ')}]`)
  }

  const hostname = hostnameOf(input.controlPlaneUrl)
  if (!hostname) {
    reasons.push(`control plane URL "${input.controlPlaneUrl}" is not a URL`)
  } else if (PROD_CONTROL_PLANES.includes(hostname)) {
    reasons.push(`control plane "${hostname}" is PRODUCTION — refusing to soak a prod host`)
  } else if (!matchesAllowList(hostname, input.allowControlPlaneHosts)) {
    reasons.push(`control plane "${hostname}" is not in the staging allow-list [${input.allowControlPlaneHosts.join(', ')}]`)
  }

  // Only ask the registry once the cheap checks pass: a prod URL must never be
  // contacted with the host's token.
  let registeredHostId: string | undefined
  if (reasons.length === 0) {
    const fetchFleet = input.fetchFleet ?? defaultFetchFleet
    const url = `${input.controlPlaneUrl.replace(/\/+$/, '')}/api/internal/metal/fleet`
    const fleet = await fetchFleet(url, input.token ?? '')
    if (!fleet.ok) {
      reasons.push(`could not confirm the host is registered to ${hostname}: ${fleet.error ?? 'fleet endpoint failed'}`)
    } else {
      const match = (fleet.hosts ?? []).find((h) => h.hostId === input.hostId)
      if (!match) reasons.push(`host "${input.hostId}" is not registered to ${hostname} (fleet has ${(fleet.hosts ?? []).length} host(s))`)
      else if (match.live === false) reasons.push(`host "${input.hostId}" is registered to ${hostname} but not live`)
      else registeredHostId = match.hostId
    }
  }

  return { ok: reasons.length === 0, reasons, registeredHostId }
}
