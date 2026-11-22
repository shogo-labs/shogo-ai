// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-509 acceptance — the process-slot exhaustion that made every spawn fail
 * with `posix_spawn EAGAIN` on 2026-11-22.
 *
 * Each `test` below is one acceptance criterion from the card:
 *   1. declaring the same command twice leaves one service; a 4th is refused
 *      with the existing three named
 *   2. a service declared for a card is released when the card finishes
 *   3. at the per-runtime group cap a background exec is refused with its
 *      holders, and works again once one is cancelled
 *   4. a crashed API starts at most one recovery for ten requests in a row
 *   5. a ledger group whose owner died is reaped; a live owner's is spared
 *   6. an EAGAIN spawn comes back explained, not raw
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_DECLARED_SERVICES,
  applyServiceDeclaration,
  declareService,
  planServiceDeclaration,
  readDeclaredServices,
  servicePort,
  type DeclaredService,
} from '../services-registry'
import {
  describeSpawnExhaustion,
  isSpawnExhaustion,
  liveGroupCount,
  processBudgetRefusal,
  releaseLiveGroup,
  resetProcessBudgetForTests,
  trackLiveGroup,
} from '../process-budget'
import { settleOutcome } from '../task-registry'
import { reapChildLedger } from '@shogo-ai/sdk/child-ledger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sho509-'))
  mkdirSync(join(dir, '.shogo'), { recursive: true })
  resetProcessBudgetForTests()
})

afterEach(() => {
  resetProcessBudgetForTests()
  rmSync(dir, { recursive: true, force: true })
})

function candidate(name: string, command: string, extra: Partial<DeclaredService> = {}): DeclaredService {
  return { name, command, cwd: dir, sessionId: 'chat', declaredAt: Date.now(), ...extra }
}

describe('1 — duplicate declarations and the per-project cap', () => {
  test('the same command declared twice leaves one service', () => {
    const first = planServiceDeclaration([], candidate('web', 'bun run dev --port 5173'))
    expect(first.action).toBe('add')
    applyServiceDeclaration(dir, first)

    // Same target, different name: still the same service.
    const second = planServiceDeclaration(readDeclaredServices(dir), candidate('web-again', 'bun run dev --port 5173'))
    expect(second.action).toBe('replace')
    expect(second.replaced?.name).toBe('web')
    applyServiceDeclaration(dir, second)

    expect(readDeclaredServices(dir)).toHaveLength(1)
    expect(readDeclaredServices(dir)[0]!.name).toBe('web-again')
  })

  test('a 4th service is refused and the refusal names the existing three', () => {
    for (const name of ['one', 'two', 'three']) {
      const plan = planServiceDeclaration(readDeclaredServices(dir), candidate(name, `sleep 1000 #${name}`))
      expect(plan.action).toBe('add')
      applyServiceDeclaration(dir, plan)
    }
    expect(readDeclaredServices(dir)).toHaveLength(MAX_DECLARED_SERVICES)

    const refused = planServiceDeclaration(readDeclaredServices(dir), candidate('four', 'sleep 1000 #four'))
    expect(refused.action).toBe('refuse')
    expect(refused.error).toContain('one')
    expect(refused.error).toContain('two')
    expect(refused.error).toContain('three')
    expect(refused.error).toContain('task_cancel')
    expect(readDeclaredServices(dir)).toHaveLength(MAX_DECLARED_SERVICES)
  })

  test('a port identifies a service even when the command text differs', () => {
    expect(servicePort('bun run dev --port 5173')).toBe(5173)
    expect(servicePort('PORT=5173 bun run dev')).toBe(5173)
    expect(servicePort('bun run dev')).toBeUndefined()

    applyServiceDeclaration(dir, planServiceDeclaration([], candidate('a', 'bun run dev --port 5173')))
    const plan = planServiceDeclaration(readDeclaredServices(dir), candidate('b', 'bun run dev --port 5173 --host'))
    expect(plan.action).toBe('replace')
  })
})

describe('2 — a card’s service is released when the card finishes', () => {
  test('releaseCardServices undeclares the card’s services and leaves the rest', async () => {
    const { AgentGateway } = await import('../gateway')
    declareService(dir, candidate('card-svc', 'sleep 1000 #card', { workItemKey: 'SHO-509' }))
    declareService(dir, candidate('other-svc', 'sleep 1000 #other', { workItemKey: 'SHO-500' }))

    const gateway = new AgentGateway(dir, 'test')
    const released = await gateway.releaseCardServices('sho-509')

    expect(released).toContain('card-svc')
    const remaining = readDeclaredServices(dir).map((s) => s.name)
    expect(remaining).toEqual(['other-svc'])
  }, 20_000)
})

describe('3 — the per-runtime group budget', () => {
  test('at the cap a new background group is refused, naming its holders', () => {
    const env = { SHOGO_MAX_PROCESS_GROUPS: '2' } as NodeJS.ProcessEnv
    expect(processBudgetRefusal(env)).toBeUndefined()

    trackLiveGroup({ id: 't_aaa', label: 'bun run dev', startedAt: Date.now() - 60_000 })
    trackLiveGroup({ id: 't_bbb', label: 'bun run server', startedAt: Date.now() - 30_000 })
    expect(liveGroupCount()).toBe(2)

    const refusal = processBudgetRefusal(env)
    expect(refusal).toBeDefined()
    expect(refusal).toContain('t_aaa')
    expect(refusal).toContain('bun run dev')
    expect(refusal).toContain('task_cancel')

    // Cancelling one frees the slot: the next spawn is allowed.
    releaseLiveGroup('t_aaa')
    expect(processBudgetRefusal(env)).toBeUndefined()
  })
})

describe('4 — a crashed API recovers once, not once per request', () => {
  test('ten recovery requests in a row start one sidecar', async () => {
    const { PreviewManager } = await import('../preview-manager')
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 0 } as any)
    ;(pm as any).apiPhase = 'crashed'

    let starts = 0
    let releaseStart!: () => void
    const started = new Promise<void>((resolve) => { releaseStart = resolve })
    ;(pm as any)._startApiServerImpl = async () => {
      starts += 1
      await started
    }

    for (let i = 0; i < 10; i++) pm.maybeRecoverApiServer()
    expect(starts).toBe(1)

    releaseStart()
    await new Promise((r) => setTimeout(r, 10))
    expect(starts).toBe(1)
  }, 20_000)
})

describe('5 — a ledger group whose owner died is reaped', () => {
  test('dead owner reaped, live owner spared', async () => {
    const { addChildLedgerEntry, readChildLedger } = await import('@shogo-ai/sdk/child-ledger')

    // A "previous runtime" that has already exited.
    const deadOwner = spawn('sh', ['-c', 'exit 0'])
    await new Promise((r) => deadOwner.once('exit', r))
    const deadOwnerPid = deadOwner.pid!

    // Two children that are still running, each in its own process group:
    // one orphaned by the dead runtime, one owned by this (live) process.
    const orphan: ChildProcess = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const owned: ChildProcess = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const orphanPid = orphan.pid!
    const ownedPid = owned.pid!

    addChildLedgerEntry(dir, {
      pgid: orphanPid, pid: orphanPid, label: 'exec', commandFingerprint: 'sleep 30',
      startedAt: Date.now(), ownerPid: deadOwnerPid,
    })
    addChildLedgerEntry(dir, {
      pgid: ownedPid, pid: ownedPid, label: 'exec', commandFingerprint: 'sleep 30',
      startedAt: Date.now(), ownerPid: process.pid,
    })

    try {
      const result = reapChildLedger(dir, { spareLiveOwners: true, reapOwnerless: true })
      expect(result.reaped.map((e) => e.pid)).toEqual([orphanPid])
      expect(result.spared.map((e) => e.pid)).toEqual([ownedPid])
      // The spared entry stays for the next pass; the reaped one is gone.
      expect(readChildLedger(dir).map((e) => e.pid)).toEqual([ownedPid])
    } finally {
      for (const pid of [orphanPid, ownedPid]) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  }, 20_000)
})

describe('6 — EAGAIN is explained, not raw', () => {
  test('a spawn-exhaustion message is recognised', () => {
    expect(isSpawnExhaustion('spawn EAGAIN')).toBe(true)
    expect(isSpawnExhaustion('posix_spawn failed: Resource temporarily unavailable')).toBe(true)
    expect(isSpawnExhaustion('ENOENT')).toBe(false)
  })

  test('the explained message names the runtime’s live groups', () => {
    trackLiveGroup({ id: 't_ccc', label: 'bun run dev', startedAt: Date.now() })
    const message = describeSpawnExhaustion('spawn EAGAIN')
    expect(message).toContain('process slots')
    expect(message).toContain('t_ccc')
    expect(message).toContain('task_cancel')
  })

  test('a failed spawn settles as failed with the explained summary', () => {
    const decision = settleOutcome({ spawnError: 'spawn EAGAIN' })
    expect(decision.status).toBe('failed')
    expect(decision.summary).toContain('process slots')
  })

  test('a non-EAGAIN spawn error is still reported plainly', () => {
    const decision = settleOutcome({ spawnError: 'spawn ENOENT' })
    expect(decision.status).toBe('failed')
    expect(decision.summary).toContain('could not start')
  })
})
