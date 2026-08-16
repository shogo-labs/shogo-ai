// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Who is allowed to command this host.
 *
 * The control API on :9900 shipped unauthenticated. The header comment in
 * server.ts said auth arrived "over the WireGuard mesh" — but the mesh was
 * never built, `METAL_LISTEN_HOST` is `0.0.0.0`, and these hosts have public
 * IPs, so `curl http://<host>:9900/destroy -d '{"projectId":"..."}'` worked
 * from anywhere on the internet against every production host.
 *
 * The token to fix it was already on both ends: hosts set
 * `METAL_REGISTER_TOKEN` (used outbound for register/heartbeat) and the API's
 * `SHOGO_INTERNAL_SECRET` is the same value. What was missing was anyone
 * checking it — and, on the API side, anyone SENDING it (see `agentHeaders()`
 * in metal-warm-pool-controller.ts, which read only the name the pods do not
 * set). That asymmetry is why this rolls out in modes rather than at once: turn
 * checking on before every caller is known to send, and the control plane loses
 * the fleet.
 *
 * Deliberately pure and free of I/O so the decision table is unit-testable
 * without a server; server.ts owns the metrics, logging and response.
 */

import { createHash, timingSafeEqual } from 'crypto'

import { HYDRATE_STREAM_PREFIX } from './hydrate-proxy'

/**
 * How strictly to treat an uncredentialed request.
 *
 *   off      — do not check. Escape hatch only.
 *   observe  — check, count, serve anyway. The interlock: it converts "every
 *              caller should be sending the token now" from a belief into a
 *              number you can watch reach zero before it can hurt anyone.
 *   enforce  — check, 401 on failure.
 */
export type AuthMode = 'off' | 'observe' | 'enforce'

/**
 * Default `observe`, so deploying this code changes no behaviour anywhere and
 * enforcement is a separate, deliberate act.
 *
 * An unrecognised value also lands on `observe`. The two failure directions are
 * not symmetric: reading a typo as `off` would silently leave the hole open
 * while the env file claims otherwise, and reading it as `enforce` would lock
 * out a control plane the operator never meant to cut off. `observe` is wrong
 * loudly instead of quietly — it keeps serving and keeps counting.
 */
export function parseAuthMode(raw: string | null | undefined): AuthMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'off') return 'off'
  if (v === 'enforce') return 'enforce'
  return 'observe'
}

/** Every control path this agent serves. Anything else buckets to `other`. */
const KNOWN_PATHS = new Set([
  '/healthz',
  '/version',
  '/vms',
  '/metrics',
  '/assign',
  '/gc',
  '/suspend',
  '/resume',
  '/touch',
  '/status',
  '/stop',
  '/destroy',
  '/resize',
])

/**
 * Collapse a request path to a bounded label.
 *
 * The metric name IS the map key in `metrics.ts`, so an unbucketed path would
 * let anyone on the internet grow that map without limit — a port scanner
 * walking /a, /b, /c would turn a security counter into a memory leak, and
 * every one of those keys would then be copied into each heartbeat payload.
 * Hydrate tokens are collapsed for the same reason, and because they are
 * credentials that must not be written to logs or metrics.
 */
export function bucketPath(path: string): string {
  if (KNOWN_PATHS.has(path)) return path
  if (path.startsWith(HYDRATE_STREAM_PREFIX)) return `${HYDRATE_STREAM_PREFIX}*`
  return 'other'
}

/**
 * Paths that must never require the control-plane bearer.
 *
 * `/healthz` is the liveness probe: it returns a constant, discloses nothing,
 * and is what systemd and the deploy script use to decide whether the agent
 * came back. Gating it would mean a misconfigured token reads as a dead host
 * and triggers rollbacks during the very rollout that caused it.
 *
 * `/hydrate-stream/*` is not control-plane traffic at all. The caller is a
 * local guest pulling its own archive over its tap link, and it authenticates
 * with the unguessable single-use token in its path, pinned to the guest it was
 * minted for (see hydrate-proxy.ts). It cannot present the control-plane bearer
 * because that secret is deliberately not inside the guest — putting it there
 * would hand every user's VM the keys to the fleet. Gating this path would
 * break every cold boot.
 */
export function isAuthExempt(path: string): boolean {
  return path === '/healthz' || path.startsWith(HYDRATE_STREAM_PREFIX)
}

/**
 * True for a peer on this host's loopback.
 *
 * Loopback is exempt, and that concedes nothing: reaching 127.0.0.1 on this box
 * already requires being on this box, where `/etc/metal-agent.env` holds the
 * token in plaintext and root can restart the agent regardless. It is also what
 * keeps the enforcement flip operable — every operator entry point we have
 * (`destroy-all-projects.sh`, the health and status checks in
 * `deploy-fleet.sh`, the runbook's `curl localhost:9900/vms`) runs on the host
 * against localhost, and those are the tools you reach for during the incident
 * that enforcement itself might cause.
 *
 * Guests cannot borrow it: they arrive over a tap interface with a 172.16/12
 * source, and a packet claiming a loopback source on a non-loopback interface
 * is a martian that Linux drops by default. Phase 3 adds an explicit rule
 * rather than leaning on that default.
 */
export function isLoopback(ip: string | null | undefined): boolean {
  if (!ip) return false
  return ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

/** The token out of an `Authorization: Bearer <token>` header, or ''. */
export function bearerToken(authorization: string | null | undefined): string {
  if (!authorization) return ''
  const m = /^bearer\s+(\S.*)$/i.exec(authorization.trim())
  return m ? m[1].trim() : ''
}

/**
 * Constant-time secret comparison.
 *
 * Hashing first is what makes it constant-time in practice: `timingSafeEqual`
 * throws on length mismatch, so comparing the raw strings would force a
 * length check that leaks the token's length through control flow. Two SHA-256
 * digests are always 32 bytes, so every comparison takes the same path.
 */
export function secretEquals(a: string, b: string): boolean {
  if (!a || !b) return false
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

export type AuthReason =
  /** Path is outside the control-plane API (`/healthz`, hydrate). */
  | 'exempt'
  /** Caller is on this host's loopback. */
  | 'loopback'
  /** Mode is `off`. */
  | 'disabled'
  /** Presented a matching bearer. */
  | 'token'
  /** No `Authorization` header. */
  | 'missing'
  /** Presented a bearer that did not match. */
  | 'mismatch'
  /** This host has no token configured, so it can verify nobody. */
  | 'unconfigured'

export interface AuthResult {
  /** Whether the request may proceed. */
  allow: boolean
  reason: AuthReason
  /**
   * The request was not properly credentialed. True even when `allow` is true
   * in `observe` mode — this is the number that must reach zero before anyone
   * flips a host to `enforce`.
   */
  suspicious: boolean
}

/**
 * The decision table. `mode` affects only whether a failure is fatal, never
 * whether the check runs, so `observe` measures exactly what `enforce` would do.
 */
export function decideControlAuth(input: {
  mode: AuthMode
  path: string
  authorization?: string | null
  /** The host's configured control token (`config.registerToken`). */
  expectedToken: string
  peerIp?: string | null
}): AuthResult {
  const pass = (reason: AuthReason): AuthResult => ({ allow: true, reason, suspicious: false })
  // In `enforce` a failure is a 401; otherwise it is served and counted.
  const fail = (reason: AuthReason): AuthResult => ({
    allow: input.mode !== 'enforce',
    reason,
    suspicious: true,
  })

  if (isAuthExempt(input.path)) return pass('exempt')
  if (input.mode === 'off') return pass('disabled')
  if (isLoopback(input.peerIp)) return pass('loopback')

  // No configured token means this host cannot tell the control plane from an
  // attacker, so it refuses everyone rather than trusting everyone. That is
  // survivable precisely because loopback was cleared above: an operator can
  // still reach the agent over ssh to fix the env file.
  if (!input.expectedToken) return fail('unconfigured')

  const presented = bearerToken(input.authorization)
  if (!presented) return fail('missing')
  return secretEquals(presented, input.expectedToken) ? pass('token') : fail('mismatch')
}
