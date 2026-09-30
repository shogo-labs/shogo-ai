// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fetch a public URL on behalf of a user without reaching internal
 * services: every hop (including redirects) must resolve only to public
 * addresses, responses are size-capped, and requests time out.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { validateOutboundUrl } from './url-validation'

export class UnsafeUrlError extends Error {}

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return ipv4Private(ip)
  if (family !== 6) return true
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v6 === '::' || v6 === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped) return ipv4Private(mapped[1])
  const first = parseInt(v6.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

type Resolver = (host: string) => Promise<string[]>
let resolveHost: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

export async function assertPublicUrl(raw: string): Promise<URL> {
  const problem = validateOutboundUrl(raw)
  if (problem) throw new UnsafeUrlError(problem)
  const url = new URL(raw)
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URLs are not allowed')
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new UnsafeUrlError('Port not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => [])
  if (!addresses.length) throw new UnsafeUrlError('Host does not resolve')
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError('Host resolves to a private address')
  return url
}

export interface SafeFetchResult {
  url: string
  status: number
  contentType: string
  body: string
}

export async function safeFetchText(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; accept?: string } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 512 * 1024
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 5_000)
  let current = raw
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const url = await assertPublicUrl(current)
    const res = await fetch(url, {
      redirect: 'manual',
      signal: deadline,
      headers: {
        'User-Agent': 'ShogoBot/1.0 (+https://shogo.ai; link previews)',
        Accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      },
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString()
      await res.body?.cancel().catch(() => {})
      continue
    }
    const contentType = res.headers.get('content-type') ?? ''
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      while (size < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.byteLength
      }
      await reader.cancel().catch(() => {})
    }
    const buf = new Uint8Array(Math.min(size, maxBytes))
    let offset = 0
    for (const c of chunks) {
      const take = Math.min(c.byteLength, buf.byteLength - offset)
      buf.set(c.subarray(0, take), offset)
      offset += take
      if (offset >= buf.byteLength) break
    }
    return { url: url.toString(), status: res.status, contentType, body: new TextDecoder().decode(buf) }
  }
  throw new UnsafeUrlError('Too many redirects')
}

export function _setResolverForTests(fn: Resolver | null): void {
  resolveHost = fn ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address))
}
