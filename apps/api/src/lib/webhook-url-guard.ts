// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Outbound webhook URLs are user-supplied, so they must not reach the API's
 * own network: https only, and neither the literal host nor anything it
 * resolves to may be loopback, private, link-local or otherwise internal.
 *
 * `SHOGO_WEBHOOK_ALLOWED_HOSTS` (comma-separated `host[:port]`) exempts test
 * receivers outside production; it is ignored when NODE_ENV=production.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookUrlError'
  }
}

function allowedTestHosts(): Set<string> {
  if (process.env.NODE_ENV === 'production') return new Set()
  return new Set(
    (process.env.SHOGO_WEBHOOK_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  )
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4ToInt(address)
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (value & mask) === (ipv4ToInt(base) & mask)
    })
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedAddress(mapped[1])
    const first = parseInt(lower.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true // multicast
    return false
  }
  return true
}

/**
 * Throws `WebhookUrlError` when `raw` may not be used. With `resolve`, also
 * checks every address the hostname resolves to (call it at delivery time so
 * a DNS change can't point an accepted URL inward).
 */
export async function assertWebhookUrlAllowed(raw: string, opts: { resolve?: boolean } = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebhookUrlError('Webhook URL is not a valid URL')
  }
  if (url.username || url.password) throw new WebhookUrlError('Webhook URL must not contain credentials')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const allow = allowedTestHosts()
  if (allow.has(host) || allow.has(`${host}:${url.port}`)) return url
  if (url.protocol !== 'https:') throw new WebhookUrlError('Webhook URL must use https')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new WebhookUrlError('Webhook URL must be publicly reachable')
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new WebhookUrlError('Webhook URL must not point to a private or internal address')
    return url
  }
  if (opts.resolve) {
    let addresses: Array<{ address: string }>
    try {
      addresses = await lookup(host, { all: true })
    } catch {
      throw new WebhookUrlError(`Webhook host ${host} does not resolve`)
    }
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      throw new WebhookUrlError('Webhook URL resolves to a private or internal address')
    }
  }
  return url
}
