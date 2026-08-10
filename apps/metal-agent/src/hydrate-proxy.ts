// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The host fetching a durable archive on the guest's behalf.
 *
 * Cold boot hands the guest a presigned S3 URL and lets it pull with a single
 * `curl` into `tar`. That is the right shape — the kernel pipe supplies
 * backpressure and neither side holds the archive — but one connection is a bad
 * bet against this object store. Measured from a production host on the same
 * 217 MB object minutes apart, a single stream ran at 91 MB/s and then 4.0 MB/s,
 * while eight-wide over that slow patch still held 49.6 MB/s. The slow mode is
 * per-connection, so parallelism is not extra bandwidth so much as insurance:
 * one bad connection costs one part instead of the transfer. Guests measured
 * 1.5-10.6 MB/s against a ~100 s budget, which is why large projects 524.
 *
 * The guest cannot take that route itself without a new runtime image, and
 * rebuilding the rootfs invalidates every snapshot on the fleet — the very thing
 * that turns an ordinary day into a fleet-wide cold-boot storm. So the host does
 * it: it fetches the object N-wide, reassembles in order, and serves the result
 * to the guest as one ordinary stream over the tap link. The guest is unchanged;
 * it pulls a URL, as it already does.
 *
 * This adds no uplink traffic, because the guest's pull is NATed through this
 * host either way. It only moves where the connections are made.
 *
 * Degrading is always safe: when this cannot mint a grant the caller falls back
 * to the presigned S3 URL, which is exactly today's behaviour.
 */

import { randomBytes } from 'crypto'

import { rangedStream } from './ranged-stream'
import type { RangeFetcher } from './snapshot-store'

export interface HydrateProxyOptions {
  /** Bytes per ranged GET. */
  partBytes: number
  /** Ranged GETs in flight per transfer; also the read-ahead window. */
  concurrency: number
  /**
   * Transfers allowed at once. Each holds at most `partBytes * concurrency` in
   * memory, so this is the host's exposure: the product is the ceiling. Beyond
   * it, callers fall back to the presigned URL rather than queue — a cold boot
   * waiting for a slot would be slower than the path we are replacing.
   */
  maxConcurrent: number
  /** How long a grant is valid. Short: it is redeemed seconds after minting. */
  ttlSec: number
  /** Port the agent listens on, for the URL handed to the guest. */
  port: number
}

interface Grant {
  range: RangeFetcher
  size: number
  label: string
  /** Only this guest may redeem it. */
  guestIp: string
  expiresAt: number
}

export const HYDRATE_STREAM_PREFIX = '/hydrate-stream/'

export class HydrateProxy {
  private grants = new Map<string, Grant>()
  /** Grants minted but not yet finished — the thing `maxConcurrent` bounds. */
  private active = 0

  constructor(
    private readonly opts: HydrateProxyOptions,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  get inFlight(): number {
    return this.active
  }

  /**
   * Mint a URL the guest can pull this archive from, or null to fall back.
   *
   * Null is not an error: no range capability, a size we cannot split, or the
   * host already carrying its limit. Every one of those degrades to the
   * presigned URL.
   */
  mint(args: {
    hostIp: string | undefined
    guestIp: string | undefined
    size: number
    label: string
    range?: RangeFetcher
  }): string | null {
    this.sweep()
    if (!args.range || args.size <= 0) return null
    // Without both addresses there is no URL to hand out and no one to pin the
    // grant to. Decline rather than mint something unreachable.
    if (!args.hostIp || !args.guestIp) return null
    // One part is one connection, which is the case this exists to avoid — and
    // for a small archive the single stream is not the bottleneck anyway.
    if (args.size <= this.opts.partBytes) return null
    if (this.active >= this.opts.maxConcurrent) return null

    const token = randomBytes(32).toString('hex')
    this.grants.set(token, {
      range: args.range,
      size: args.size,
      label: args.label,
      guestIp: args.guestIp!,
      expiresAt: this.now() + this.opts.ttlSec * 1000,
    })
    this.active++
    return `http://${args.hostIp}:${this.opts.port}${HYDRATE_STREAM_PREFIX}${token}`
  }

  /**
   * Serve a minted grant. Returns 404 for anything unknown, expired, or asked
   * for by a guest other than the one it was minted for — the token is the
   * capability, and it is worth nothing off its own tap.
   */
  serve(path: string, requesterIp: string | null): Response {
    const token = path.slice(HYDRATE_STREAM_PREFIX.length)
    const grant = this.grants.get(token)
    if (!grant || grant.expiresAt <= this.now()) {
      this.sweep()
      return new Response('not found', { status: 404 })
    }
    if (requesterIp && requesterIp !== grant.guestIp) {
      return new Response('not found', { status: 404 })
    }

    // Single use: the guest pulls once, and a grant that stays redeemable is
    // just a capability lying around. A retry re-mints.
    this.grants.delete(token)

    let released = false
    const startedAt = this.now()
    const release = (sent: number) => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      // The throughput line. Cold-boot hydrate had no per-transfer rate
      // anywhere, which is why "why is a cold boot slow" had to be answered by
      // pairing log timestamps against object sizes after the fact.
      const secs = Math.max(0.001, (this.now() - startedAt) / 1000)
      const rate = (sent / 1e6 / secs).toFixed(1)
      const how = sent === grant.size ? 'served' : `TRUNCATED (${sent}/${grant.size})`
      this.log(`[pool] ${how} ${grant.label} to ${grant.guestIp}: ${grant.size} bytes in ${secs.toFixed(1)}s (${rate} MB/s)`)
    }

    const body = rangedStream(grant.size, grant.range, {
      partBytes: this.opts.partBytes,
      concurrency: this.opts.concurrency,
    })

    return new Response(withRelease(body, release), {
      headers: {
        'Content-Type': 'application/gzip',
        // Declared so the guest's curl can tell a complete transfer from a
        // truncated one. If a part fails mid-stream the body ends short of
        // this and curl fails, rather than tar extracting a partial tree.
        'Content-Length': String(grant.size),
        'Cache-Control': 'no-store',
      },
    })
  }

  /** Drop grants nobody redeemed, so a failed assign does not hold a slot. */
  private sweep(): void {
    const now = this.now()
    for (const [token, g] of this.grants) {
      if (g.expiresAt <= now) {
        this.grants.delete(token)
        this.active = Math.max(0, this.active - 1)
      }
    }
  }
}

/**
 * Run `release` exactly once when the stream ends, however it ends.
 *
 * The slot has to come back on cancel and error as well as completion — a guest
 * that dies mid-hydrate is the common case for the failures this path is meant
 * to fix, and leaking a slot each time would silently retire the proxy.
 */
function withRelease(
  src: ReadableStream<Uint8Array>,
  release: (sent: number) => void,
): ReadableStream<Uint8Array> {
  const reader = src.getReader()
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release(sent)
          controller.close()
          return
        }
        sent += value!.length
        controller.enqueue(value!)
      } catch (err) {
        release(sent)
        throw err
      }
    },
    async cancel(reason) {
      release(sent)
      await reader.cancel(reason)
    },
  })
}
