// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LAN Advertisement — mDNS/Bonjour Service Broadcast
 *
 * Publishes a `_shogo._tcp` service on the local network so that
 * mobile devices can discover and connect directly to this desktop
 * instance without going through the cloud relay.
 *
 * Uses Electron's built-in Bonjour / multicast-dns when available,
 * or falls back to a no-op if the platform doesn't support it.
 *
 * The TXT record includes:
 *   - instanceId: the registered cloud instance ID (if known)
 *   - protocolVersion: tunnel protocol version
 *   - apiVersion: local API version
 */

import { hostname as osHostname } from 'os'

let advertiser: any = null
let published = false

export interface LANAdvertiseOptions {
  port: number
  instanceId?: string
  protocolVersion?: number
  apiVersion?: string
}

/**
 * Start advertising this Shogo instance on the local network.
 *
 * This is a best-effort operation — if mDNS isn't available
 * (e.g. in certain containerized environments), it silently no-ops.
 */
export async function startLANAdvertise(opts: LANAdvertiseOptions): Promise<void> {
  if (published) return

  try {
    // Dynamically import multicast-dns or bonjour if available
    const mdns = await tryLoadMdns()
    if (!mdns) {
      console.log('[LANAdvertise] No mDNS module available — skipping LAN broadcast')
      return
    }

    const txtRecord: Record<string, string> = {
      instanceId: opts.instanceId || 'unknown',
      protocolVersion: String(opts.protocolVersion || 1),
      apiVersion: opts.apiVersion || '0.1.0',
    }

    advertiser = mdns
    mdns.publish({
      name: `shogo-${osHostname()}`,
      type: '_shogo._tcp',
      port: opts.port,
      txt: txtRecord,
    })

    published = true
    console.log(`[LANAdvertise] Broadcasting _shogo._tcp on port ${opts.port}`)
  } catch (err: any) {
    console.warn(`[LANAdvertise] Failed to start: ${err.message}`)
  }
}

/**
 * Stop advertising.
 */
export function stopLANAdvertise(): void {
  if (!published || !advertiser) return

  try {
    advertiser.unpublish?.()
    advertiser.destroy?.()
  } catch {}

  advertiser = null
  published = false
  console.log('[LANAdvertise] Stopped broadcasting')
}

/**
 * Try to load a Bonjour/mDNS library. Returns null if none available.
 */
async function tryLoadMdns(): Promise<any> {
  // Try bonjour-service first (common Electron mDNS library)
  try {
    const { Bonjour } = await import('bonjour-service')
    return new Bonjour()
  } catch {}

  // Try mdns / multicast-dns
  try {
    const mdns = await import('multicast-dns')
    return mdns.default?.() || mdns()
  } catch {}

  return null
}
