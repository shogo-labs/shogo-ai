// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'

import {
  type AuthMode,
  bearerToken,
  bucketPath,
  decideControlAuth,
  isAuthExempt,
  isLoopback,
  parseAuthMode,
  secretEquals,
} from './auth'

const TOKEN = 'the-shared-control-plane-token'

/** A control-plane call as the API actually makes it, per `agentHeaders()`. */
function controlPlaneCall(mode: AuthMode, over: Partial<Parameters<typeof decideControlAuth>[0]> = {}) {
  return decideControlAuth({
    mode,
    path: '/assign',
    authorization: `Bearer ${TOKEN}`,
    expectedToken: TOKEN,
    peerIp: '129.80.99.116',
    ...over,
  })
}

describe('parseAuthMode', () => {
  test('defaults to observe, so deploying the code enforces nothing', () => {
    expect(parseAuthMode(undefined)).toBe('observe')
    expect(parseAuthMode('')).toBe('observe')
    expect(parseAuthMode('   ')).toBe('observe')
  })

  test('reads the three modes, case and whitespace insensitively', () => {
    expect(parseAuthMode('off')).toBe('off')
    expect(parseAuthMode('observe')).toBe('observe')
    expect(parseAuthMode('enforce')).toBe('enforce')
    expect(parseAuthMode('  ENFORCE  ')).toBe('enforce')
  })

  test('a typo falls back to observe rather than off or enforce', () => {
    // Both other readings are silent disasters: `off` would leave the hole open
    // while the env file claims otherwise, `enforce` would cut off a control
    // plane nobody meant to cut off.
    expect(parseAuthMode('enforcee')).toBe('observe')
    expect(parseAuthMode('true')).toBe('observe')
    expect(parseAuthMode('1')).toBe('observe')
  })
})

describe('bucketPath (an internet-facing metric label must be bounded)', () => {
  test('known control paths label as themselves', () => {
    expect(bucketPath('/assign')).toBe('/assign')
    expect(bucketPath('/destroy')).toBe('/destroy')
    expect(bucketPath('/vms')).toBe('/vms')
  })

  test('a port scanner cannot grow the counter map', () => {
    // The metric name is the map key, so unbucketed paths would be an
    // unbounded memory leak reachable by anyone, copied into every heartbeat.
    expect(bucketPath('/wp-login.php')).toBe('other')
    expect(bucketPath('/../../etc/passwd')).toBe('other')
    expect(bucketPath('/a')).toBe(bucketPath('/b'))
  })

  test('hydrate tokens are collapsed, never emitted as labels', () => {
    const label = bucketPath('/hydrate-stream/ffb1c0de-secret-grant')
    expect(label).toBe('/hydrate-stream/*')
    expect(label).not.toContain('secret-grant')
  })
})

describe('isLoopback', () => {
  test('recognises v4, v6 and v4-mapped loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.0.0.53')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
  })

  test('a guest on its tap link is not loopback', () => {
    // The exemption must not be reachable from inside a user's VM.
    expect(isLoopback('172.16.5.250')).toBe(false)
    expect(isLoopback('172.16.0.1')).toBe(false)
  })

  test('is not fooled by lookalikes or a missing peer', () => {
    expect(isLoopback('128.0.0.1')).toBe(false)
    expect(isLoopback('10.127.0.1')).toBe(false)
    expect(isLoopback(null)).toBe(false)
    expect(isLoopback('')).toBe(false)
  })
})

describe('bearerToken', () => {
  test('extracts the token regardless of header casing or padding', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN)
    expect(bearerToken(`bearer ${TOKEN}`)).toBe(TOKEN)
    expect(bearerToken(`  Bearer   ${TOKEN}  `)).toBe(TOKEN)
  })

  test('returns empty for anything that is not a bearer', () => {
    expect(bearerToken(null)).toBe('')
    expect(bearerToken('')).toBe('')
    expect(bearerToken(TOKEN)).toBe('')
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBe('')
    expect(bearerToken('Bearer')).toBe('')
    expect(bearerToken('Bearer   ')).toBe('')
  })
})

describe('secretEquals', () => {
  test('matches identical secrets and rejects everything else', () => {
    expect(secretEquals(TOKEN, TOKEN)).toBe(true)
    expect(secretEquals(TOKEN, `${TOKEN}x`)).toBe(false)
    expect(secretEquals(TOKEN, TOKEN.toUpperCase())).toBe(false)
  })

  test('a prefix of the real token does not pass', () => {
    expect(secretEquals(TOKEN.slice(0, -1), TOKEN)).toBe(false)
  })

  test('empty never matches, so an unset token is not a skeleton key', () => {
    expect(secretEquals('', '')).toBe(false)
    expect(secretEquals('', TOKEN)).toBe(false)
    expect(secretEquals(TOKEN, '')).toBe(false)
  })

  test('differing lengths are rejected, not thrown on', () => {
    // timingSafeEqual throws on length mismatch; hashing first is what makes
    // this both safe to call and constant-time.
    expect(() => secretEquals('a', 'a-much-longer-secret')).not.toThrow()
    expect(secretEquals('a', 'a-much-longer-secret')).toBe(false)
  })
})

describe('isAuthExempt', () => {
  test('/healthz is open so a token problem cannot read as a dead host', () => {
    expect(isAuthExempt('/healthz')).toBe(true)
  })

  test('hydrate keeps its own credential', () => {
    expect(isAuthExempt('/hydrate-stream/abc123')).toBe(true)
  })

  test('nothing else is exempt', () => {
    for (const p of ['/assign', '/destroy', '/suspend', '/vms', '/metrics', '/touch', '/']) {
      expect(isAuthExempt(p)).toBe(false)
    }
  })
})

describe('decideControlAuth: the control plane keeps working', () => {
  test('a correctly credentialed call passes in every mode', () => {
    for (const mode of ['off', 'observe', 'enforce'] as const) {
      const r = controlPlaneCall(mode)
      expect({ mode, allow: r.allow, suspicious: r.suspicious }).toEqual({ mode, allow: true, suspicious: false })
    }
    // `off` short-circuits before the token is examined, so only the modes that
    // actually check can report having verified one.
    expect(controlPlaneCall('observe').reason).toBe('token')
    expect(controlPlaneCall('enforce').reason).toBe('token')
    expect(controlPlaneCall('off').reason).toBe('disabled')
  })

  test('/touch passes too — the highest-frequency call, and the one that used to send no header', () => {
    const r = controlPlaneCall('enforce', { path: '/touch' })
    expect(r.allow).toBe(true)
    expect(r.suspicious).toBe(false)
  })

  test('a cold boot survives enforcement: the guest hydrates with no bearer', () => {
    const r = decideControlAuth({
      mode: 'enforce',
      path: '/hydrate-stream/single-use-grant',
      authorization: null,
      expectedToken: TOKEN,
      peerIp: '172.16.5.250',
    })
    expect(r.allow).toBe(true)
    expect(r.reason).toBe('exempt')
    expect(r.suspicious).toBe(false)
  })

  test('liveness survives enforcement with no credential at all', () => {
    const r = decideControlAuth({ mode: 'enforce', path: '/healthz', expectedToken: TOKEN, peerIp: '8.8.8.8' })
    expect(r.allow).toBe(true)
    expect(r.reason).toBe('exempt')
  })

  test('operator tooling on the host keeps working under enforcement', () => {
    // destroy-all-projects.sh, deploy-fleet.sh's health checks and the
    // runbook's `curl localhost:9900/vms` all run on-host without a token.
    const r = decideControlAuth({ mode: 'enforce', path: '/vms', expectedToken: TOKEN, peerIp: '127.0.0.1' })
    expect(r.allow).toBe(true)
    expect(r.reason).toBe('loopback')
    expect(r.suspicious).toBe(false)
  })
})

describe('decideControlAuth: the internet does not', () => {
  const anonymous = { path: '/destroy', authorization: null, expectedToken: TOKEN, peerIp: '203.0.113.9' }

  test('an uncredentialed /destroy is refused under enforce', () => {
    // The exact call that worked against every production host.
    const r = decideControlAuth({ mode: 'enforce', ...anonymous })
    expect(r.allow).toBe(false)
    expect(r.reason).toBe('missing')
    expect(r.suspicious).toBe(true)
  })

  test('under observe the same call is served, but counted', () => {
    const r = decideControlAuth({ mode: 'observe', ...anonymous })
    expect(r.allow).toBe(true)
    expect(r.suspicious).toBe(true)
    expect(r.reason).toBe('missing')
  })

  test('a wrong token is distinguishable from no token', () => {
    const r = decideControlAuth({ mode: 'enforce', ...anonymous, authorization: 'Bearer not-the-token' })
    expect(r.allow).toBe(false)
    expect(r.reason).toBe('mismatch')
  })

  test('a remote caller cannot claim loopback through a header', () => {
    // Only the socket's peer address is consulted; nothing in the request
    // can assert it. X-Forwarded-For is not, and must never become, input.
    const r = decideControlAuth({
      mode: 'enforce',
      ...anonymous,
      authorization: 'Bearer 127.0.0.1',
    })
    expect(r.allow).toBe(false)
  })

  test('every mutating route is covered, not just the ones we remembered', () => {
    for (const path of ['/assign', '/gc', '/suspend', '/resume', '/touch', '/status', '/stop', '/destroy', '/resize', '/vms', '/metrics']) {
      const r = decideControlAuth({ mode: 'enforce', path, expectedToken: TOKEN, peerIp: '203.0.113.9' })
      expect({ path, allow: r.allow }).toEqual({ path, allow: false })
    }
  })
})

describe('decideControlAuth: degenerate configurations', () => {
  test('a host with no token refuses remote callers rather than trusting them', () => {
    const r = decideControlAuth({
      mode: 'enforce',
      path: '/assign',
      authorization: `Bearer ${TOKEN}`,
      expectedToken: '',
      peerIp: '129.80.99.116',
    })
    expect(r.allow).toBe(false)
    expect(r.reason).toBe('unconfigured')
    expect(r.suspicious).toBe(true)
  })

  test('an unconfigured host is still recoverable over ssh', () => {
    // Fail-closed is only safe because loopback is cleared first; otherwise a
    // missing env var would brick the host with no way in to repair it.
    const r = decideControlAuth({ mode: 'enforce', path: '/vms', expectedToken: '', peerIp: '127.0.0.1' })
    expect(r.allow).toBe(true)
    expect(r.reason).toBe('loopback')
  })

  test('an unconfigured host in observe mode reports rather than refuses', () => {
    const r = decideControlAuth({ mode: 'observe', path: '/assign', expectedToken: '', peerIp: '129.80.99.116' })
    expect(r.allow).toBe(true)
    expect(r.suspicious).toBe(true)
    expect(r.reason).toBe('unconfigured')
  })

  test('off is a real escape hatch: nothing is refused and nothing is counted', () => {
    const r = decideControlAuth({ mode: 'off', path: '/destroy', expectedToken: TOKEN, peerIp: '203.0.113.9' })
    expect(r.allow).toBe(true)
    expect(r.reason).toBe('disabled')
    expect(r.suspicious).toBe(false)
  })

  test('observe never refuses anything, whatever the input', () => {
    // The property the rollout depends on: turning observe on cannot cause an
    // outage, so it is safe to deploy fleet-wide before anyone has looked.
    const inputs = [
      { path: '/assign', authorization: null, expectedToken: TOKEN, peerIp: '203.0.113.9' },
      { path: '/destroy', authorization: 'Bearer wrong', expectedToken: TOKEN, peerIp: null },
      { path: '/vms', authorization: 'garbage', expectedToken: '', peerIp: '203.0.113.9' },
      { path: '/nope', authorization: null, expectedToken: TOKEN, peerIp: '203.0.113.9' },
    ]
    for (const input of inputs) {
      expect(decideControlAuth({ mode: 'observe', ...input }).allow).toBe(true)
    }
  })

  test('observe and enforce agree on the verdict, differing only in consequence', () => {
    // What makes an observe-mode zero reading a valid gate for enforcing.
    const inputs = [
      { path: '/assign', authorization: `Bearer ${TOKEN}`, expectedToken: TOKEN, peerIp: '129.80.99.116' },
      { path: '/assign', authorization: null, expectedToken: TOKEN, peerIp: '203.0.113.9' },
      { path: '/healthz', authorization: null, expectedToken: TOKEN, peerIp: '203.0.113.9' },
      { path: '/vms', authorization: null, expectedToken: TOKEN, peerIp: '127.0.0.1' },
      { path: '/hydrate-stream/x', authorization: null, expectedToken: TOKEN, peerIp: '172.16.5.250' },
    ]
    for (const input of inputs) {
      const observed = decideControlAuth({ mode: 'observe', ...input })
      const enforced = decideControlAuth({ mode: 'enforce', ...input })
      expect(observed.reason).toBe(enforced.reason)
      expect(observed.suspicious).toBe(enforced.suspicious)
      expect(enforced.allow).toBe(!observed.suspicious)
    }
  })
})
