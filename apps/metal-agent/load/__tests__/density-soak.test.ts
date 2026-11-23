// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Preflight and teardown against a fake node-agent.
 *
 * The runner talks to the host over the node-agent's HTTP API, so the fake here
 * is that API (not `test-harness/fake-metal-host.ts`, which stands in for the
 * FirecrackerVMManager *below* the pool — the runner never sees it). What this
 * proves is the part that matters for safety: preflight refuses a host that is
 * not staging-registered, the env swap is recorded and restored, teardown
 * destroys every `soak-` VM, and a real project that was resident before the
 * run is never touched.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { DensitySoak, parseArgs, parseDuration, parseEnvFile, renderEnvFile, resolveGuestUrl } from '../density-soak'

interface FakeState {
  assigned: { projectId: string }[]
  suspended: { projectId: string }[]
  destroyed: string[]
  suspendedCalls: string[]
  touched: string[]
  fleetHosts: { hostId: string; live?: boolean }[]
}

function fakeAgent(state: FakeState) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as any) : {}
      if (url.pathname === '/healthz') return Response.json({ ok: true })
      if (url.pathname === '/vms') return Response.json({ assigned: state.assigned, suspended: state.suspended })
      if (url.pathname === '/api/internal/metal/fleet') return Response.json({ ok: true, hosts: state.fleetHosts })
      if (url.pathname === '/assign') {
        const projectId = body.projectId as string
        if (!state.assigned.some((v) => v.projectId === projectId)) state.assigned.push({ projectId })
        return Response.json({ url: `http://127.0.0.1:1`, mode: 'assigned', readyMs: 120 })
      }
      if (url.pathname === '/suspend') {
        state.suspendedCalls.push(body.projectId)
        state.assigned = state.assigned.filter((v) => v.projectId !== body.projectId)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/destroy') {
        state.destroyed.push(body.projectId)
        state.assigned = state.assigned.filter((v) => v.projectId !== body.projectId)
        state.suspended = state.suspended.filter((v) => v.projectId !== body.projectId)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/touch') {
        state.touched.push(body.projectId)
        return Response.json({ ok: true })
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
}

/** The env file as the host has it, with the control plane pointed at the fake. */
function originalEnv(controlPlaneUrl: string): string {
  return `# metal-agent env
METAL_HOST_ID=soak-test-host
METAL_REGION=us
METAL_CONTROL_PLANE_URL=${controlPlaneUrl}
METAL_REGISTER_TOKEN=tok
METAL_VCPUS=2
METAL_MEM_MIB=2048
METAL_MAX_VMS_PER_HOST=80
METAL_IDLE_SUSPEND_MS=1800000
`
}

let server: ReturnType<typeof Bun.serve> | null = null
afterEach(() => {
  server?.stop(true)
  server = null
})

function setup(state: FakeState) {
  server = fakeAgent(state)
  const dir = mkdtempSync(join(tmpdir(), 'density-soak-'))
  const envFile = join(dir, 'metal-agent.env')
  const base = `http://127.0.0.1:${server.port}`
  const envText = originalEnv(base)
  writeFileSync(envFile, envText)
  return { dir, envFile, base, envText }
}

function opts(envFile: string, base: string, extra: string[] = []) {
  return parseArgs(
    [
      '--host',
      'soak-test-host',
      '--base',
      base,
      '--env-file',
      envFile,
      '--steps',
      '2',
      '--hold-ms',
      '50',
      '--allow-hosts',
      'soak-test-host',
      '--allow-control-planes',
      '127.0.0.1',
      '--assume-cordoned',
      '--no-restart-agent',
      ...extra,
    ],
    {},
  )
}

describe('parseEnvFile / renderEnvFile', () => {
  test('round-trips a systemd EnvironmentFile', () => {
    const env = parseEnvFile(originalEnv('https://api-staging.shogo.ai'))
    expect(env.METAL_HOST_ID).toBe('soak-test-host')
    expect(env.METAL_MAX_VMS_PER_HOST).toBe('80')
    expect(renderEnvFile(env)).toBe(
      'METAL_HOST_ID=soak-test-host\nMETAL_REGION=us\nMETAL_CONTROL_PLANE_URL=https://api-staging.shogo.ai\nMETAL_REGISTER_TOKEN=tok\nMETAL_VCPUS=2\nMETAL_MEM_MIB=2048\nMETAL_MAX_VMS_PER_HOST=80\nMETAL_IDLE_SUSPEND_MS=1800000\n',
    )
  })

  test('strips quotes and skips comments', () => {
    expect(parseEnvFile('# c\nA="x y"\nB=\'z\'\n')).toEqual({ A: 'x y', B: 'z' })
  })
})

describe('preflight', () => {
  test('refuses a host that is not in the staging allow-list', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base } = setup(state)
    const soak = new DensitySoak(parseArgs(['--host', 'prod-host', '--base', base, '--env-file', envFile, '--allow-hosts', 'soak-test-host', '--allow-control-planes', '127.0.0.1', '--assume-cordoned', '--no-restart-agent'], {}))
    await expect(soak.preflight()).rejects.toThrow(/not in the staging allow-list/)
  })

  test('refuses a production control plane', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base } = setup(state)
    writeFileSync(envFile, originalEnv('https://api.shogo.ai'))
    const soak = new DensitySoak(opts(envFile, base))
    await expect(soak.preflight()).rejects.toThrow(/PRODUCTION/)
  })

  test('refuses when the control plane does not list the host', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'someone-else', live: true }] }
    const { envFile, base } = setup(state)
    const soak = new DensitySoak(opts(envFile, base))
    await expect(soak.preflight()).rejects.toThrow(/is not registered/)
  })

  test('records the env and raises the cap for the run', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base } = setup(state)
    const soak = new DensitySoak(opts(envFile, base))
    await soak.preflight()
    const swapped = parseEnvFile(readFileSync(envFile, 'utf8'))
    expect(Number(swapped.METAL_MAX_VMS_PER_HOST)).toBeGreaterThanOrEqual(200)
    expect(swapped.METAL_IDLE_SUSPEND_MS).toBe('0')
    await soak.teardown()
  })

  test('a dry run stops before the env swap', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base, envText } = setup(state)
    const soak = new DensitySoak(opts(envFile, base, ['--dry-run']))
    await soak.preflight()
    expect(readFileSync(envFile, 'utf8')).toBe(envText)
  })

  test('refuses an env that an interrupted run left soaked', async () => {
    // The failure mode this guards: a run dies without its trap, leaving
    // IDLE_SUSPEND_MS=0 and MAX=200. The next run then captures *those* as its
    // original env and restores them at the end.
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base } = setup(state)
    writeFileSync(envFile, originalEnv('https://api-staging.shogo.ai').replace('METAL_IDLE_SUSPEND_MS=1800000', 'METAL_IDLE_SUSPEND_MS=0'))
    const soak = new DensitySoak(opts(envFile, base))
    await expect(soak.preflight()).rejects.toThrow(/left the host soaked/)
  })

  test('saves the pre-run env under a run-scoped name', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base, envText } = setup(state)
    const soak = new DensitySoak(opts(envFile, base))
    await soak.preflight()
    const backups = readdirSync(dirname(envFile)).filter((f) => f.includes('.pre-soak-') && f.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(envFile), backups[0]), 'utf8')).toBe(envText)
    await soak.teardown()
  })
})

describe('teardown', () => {
  test('destroys every soak VM, leaves 0, restores the env, and never touches a real project', async () => {
    const state: FakeState = {
      assigned: [{ projectId: 'real-project-1' }],
      suspended: [{ projectId: 'real-project-2' }],
      destroyed: [],
      suspendedCalls: [],
      touched: [],
      fleetHosts: [{ hostId: 'soak-test-host', live: true }],
    }
    const { envFile, base, envText } = setup(state)
    const soak = new DensitySoak(opts(envFile, base))
    await soak.preflight()
    await soak.growTo(2)

    const soakIds = state.assigned.map((v) => v.projectId).filter((p) => p.startsWith('soak-'))
    expect(soakIds).toHaveLength(2)

    await soak.teardown()

    // Every soak VM was destroyed and none is left.
    for (const id of soakIds) expect(state.destroyed).toContain(id)
    // Destroy only: suspending first uploads a snapshot per guest (~90 s each).
    expect(state.suspendedCalls).toHaveLength(0)
    expect(state.assigned.filter((v) => v.projectId.startsWith('soak-'))).toHaveLength(0)
    expect(state.suspended.filter((v) => v.projectId.startsWith('soak-'))).toHaveLength(0)

    // The real projects were never suspended or destroyed.
    expect(state.destroyed).not.toContain('real-project-1')
    expect(state.destroyed).not.toContain('real-project-2')
    expect(state.suspendedCalls).not.toContain('real-project-1')
    expect(state.suspendedCalls).not.toContain('real-project-2')

    // The env is back to exactly what it was.
    expect(readFileSync(envFile, 'utf8')).toBe(envText)
  })

  test('teardown is safe to call twice', async () => {
    const state: FakeState = { assigned: [], suspended: [], destroyed: [], suspendedCalls: [], touched: [], fleetHosts: [{ hostId: 'soak-test-host', live: true }] }
    const { envFile, base, envText } = setup(state)
    const soak = new DensitySoak(opts(envFile, base))
    await soak.preflight()
    await soak.growTo(1)
    await soak.teardown()
    await soak.teardown()
    expect(readFileSync(envFile, 'utf8')).toBe(envText)
  })
})

describe('parseDuration', () => {
  test('reads the units the runbook uses', () => {
    expect(parseDuration('10m', 0)).toBe(600_000)
    expect(parseDuration('90s', 0)).toBe(90_000)
    expect(parseDuration('2h', 0)).toBe(7_200_000)
    expect(parseDuration('500ms', 0)).toBe(500)
    expect(parseDuration('1500', 0)).toBe(1500)
  })

  test('falls back on garbage', () => {
    expect(parseDuration('soon', 42)).toBe(42)
    expect(parseDuration(undefined, 42)).toBe(42)
  })
})

describe('parseArgs', () => {
  test('--hold 5m is five minutes, not the default', () => {
    expect(parseArgs(['--hold', '5m'], {}).holdMs).toBe(300_000)
  })

  test('--hold-ms wins over --hold', () => {
    expect(parseArgs(['--hold', '5m', '--hold-ms', '1000'], {}).holdMs).toBe(1000)
  })

  test('sorts and de-duplicates nothing, but sorts the steps', () => {
    expect(parseArgs(['--steps', '160,40,80'], {}).steps).toEqual([40, 80, 160])
  })

  test('defaults to the prod mix and the staging allow-lists', () => {
    const o = parseArgs([], {})
    expect(o.mix).toEqual({ agent: 0.16, app: 0.01, idle: 0.83 })
    expect(o.allowHosts).toEqual(['latitude-dal-1'])
    expect(o.allowControlPlanes).toContain('api-staging.shogo.ai')
  })
})

describe('resolveGuestUrl', () => {
  // The live run died at baseline with "Unable to connect" because `/assign`
  // hands back the published address and the host cannot hairpin its own DNAT.
  const rules = [
    '-A PREROUTING -p tcp -m tcp --dport 20044 -j DNAT --to-destination 172.16.111.218:8080',
    '-A PREROUTING -p tcp -m tcp --dport 20011 -j DNAT --to-destination 172.16.25.234:8080',
    '-A PREROUTING -p tcp -m tcp --dport 2004 -j DNAT --to-destination 172.16.99.1:8080',
  ].join('\n')

  test('rewrites the host\'s own published address to the guest private IP', () => {
    expect(resolveGuestUrl('http://72.46.85.83:20044', '72.46.85.83', () => rules)).toBe('http://172.16.111.218:8080')
  })

  test('matches the dport exactly, not as a prefix', () => {
    expect(resolveGuestUrl('http://72.46.85.83:2004', '72.46.85.83', () => rules)).toBe('http://172.16.99.1:8080')
  })

  test('leaves a URL from another host alone', () => {
    expect(resolveGuestUrl('http://10.0.0.5:20044', '72.46.85.83', () => rules)).toBe('http://10.0.0.5:20044')
  })

  test('leaves a URL alone when no DNAT rule matches it', () => {
    expect(resolveGuestUrl('http://72.46.85.83:29999', '72.46.85.83', () => rules)).toBe('http://72.46.85.83:29999')
  })

  test('is a no-op without a URL or a known public host', () => {
    expect(resolveGuestUrl(undefined, '72.46.85.83', () => rules)).toBeUndefined()
    expect(resolveGuestUrl('http://72.46.85.83:20044', '', () => rules)).toBe('http://72.46.85.83:20044')
  })
})
