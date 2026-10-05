// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fetch a public URL on behalf of a user without reaching internal
 * services: every hop (including redirects) must resolve only to public
 * addresses, responses are size-capped, and requests time out.
 *
 * The connection is made to the exact address that was validated (a custom
 * `lookup`), so a hostname can't pass the check and then re-resolve to an
 * internal address (DNS rebinding). TLS is still verified against the
 * hostname.
 */

import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
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
  return (await resolvePublicUrl(raw)).url
}

/** Validate `raw` and return the public address to connect to. */
export async function resolvePublicUrl(raw: string): Promise<{ url: URL; address: string }> {
  const problem = validateOutboundUrl(raw)
  if (problem) throw new UnsafeUrlError(problem)
  const url = new URL(raw)
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URLs are not allowed')
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new UnsafeUrlError('Port not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => [])
  if (!addresses.length) throw new UnsafeUrlError('Host does not resolve')
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError('Host resolves to a private address')
  return { url, address: addresses[0]! }
}

export interface PinnedResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Uint8Array
}

type Transport = (url: URL, address: string, opts: { headers: Record<string, string>; maxBytes: number; signal: AbortSignal }) => Promise<PinnedResponse>

/** One HTTP request that connects only to `address`, reading at most `maxBytes`. */
export const requestPinned: Transport = (url, address, opts) => new Promise((resolve, reject) => {
  const family = isIP(address)
  const pinned: LookupFunction = (_host, options, cb) => {
    if ((options as { all?: boolean })?.all) (cb as any)(null, [{ address, family }])
    else cb(null, address, family)
  }
  const client = url.protocol === 'https:' ? https : http
  const req = client.request(url, {
    method: 'GET',
    headers: { ...opts.headers, 'Accept-Encoding': 'identity' },
    lookup: pinned,
    signal: opts.signal,
  }, (res) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      const body = Buffer.concat(chunks)
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: new Uint8Array(body.subarray(0, opts.maxBytes)) })
    }
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.byteLength
      if (size >= opts.maxBytes) {
        finish()
        res.destroy()
      }
    })
    res.on('end', finish)
    res.on('error', (err) => (settled ? undefined : reject(err)))
  })
  req.on('error', reject)
  req.end()
})

let transport: Transport = requestPinned

export function _setTransportForTests(fn: Transport | null): void {
  transport = fn ?? requestPinned
}

function header(headers: PinnedResponse['headers'], name: string): string {
  const v = headers[name]
  return Array.isArray(v) ? v[0] ?? '' : v ?? ''
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
    const { url, address } = await resolvePublicUrl(current)
    const res = await transport(url, address, {
      signal: deadline,
      maxBytes,
      headers: {
        'User-Agent': 'ShogoBot/1.0 (+https://shogo.ai; link previews)',
        Accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      },
    })
    const location = header(res.headers, 'location')
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, url).toString()
      continue
    }
    return { url: url.toString(), status: res.status, contentType: header(res.headers, 'content-type'), body: new TextDecoder().decode(res.body) }
  }
  throw new UnsafeUrlError('Too many redirects')
}

export function _setResolverForTests(fn: Resolver | null): void {
  resolveHost = fn ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address))
}
