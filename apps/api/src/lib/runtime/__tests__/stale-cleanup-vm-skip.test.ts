// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * End-to-end regression for the warm-pool VM kill race:
 *
 *   1. VMWarmPool starts and spawns QEMU on a free port in 37100-37900
 *   2. ~1s later, RuntimeManager initialises and runs its
 *      `lsof -iTCP:37100-37900 -sTCP:LISTEN -t | kill -9` pass
 *   3. The QEMU PID is in the lsof output → SIGKILLed
 *   4. Warm pool's first VM dies with code=null (signal kill)
 *   5. Every project request thereafter cold-starts a fresh VM, but
 *      by then the agent-proxy path has already routed the project
 *      to host RuntimeManager (because the warm pool wasn't ready),
 *      so the VM is never used — classic split-brain.
 *
 * The fix is the `pid-registry` filter: VM managers register their
 * QEMU PID at spawn time, RuntimeManager.cleanupStaleProcesses
 * consults the registry and excludes registered PIDs.
 *
 * We tested this end-to-end with a real `bun -e` TCP listener
 * spawned into the cleanup port range, but the spawn-then-wait-for-
 * "ready" pattern timed out under heavy concurrent test load on
 * `bun test` (~30s for child startup vs. 800ms standalone). The
 * fix's behaviour can be pinned down deterministically by mocking
 * the `execSync` boundary: we make lsof return a fabricated PID
 * list containing one registered + one unregistered PID, and assert
 * that only the unregistered one reaches the `kill -9 …` argv.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import {
  registerVMPid,
  _resetVMPidRegistry,
} from '../../../../../desktop/src/vm/pid-registry'

const VM_PID = 75951            // exactly the PID from main.log
const STALE_PID = 46285          // a real "stale" PID worth killing

// Bun's `child_process.execSync` is a read-only property on the real
// module, so we mock the module wholesale and reach into its
// state via the shared array below. RuntimeManager calls this stubbed
// `execSync` during its constructor's stale-cleanup pass.
let lsofResponse: string = ''
const killArgs: string[] = []

mock.module('child_process', () => ({
  execSync: (cmd: string): string => {
    if (cmd.startsWith('lsof')) return lsofResponse
    if (cmd.startsWith('kill -9 ')) {
      killArgs.push(cmd)
      return ''
    }
    return ''
  },
  // RuntimeManager also uses spawn — we don't exercise start() in
  // these tests, but the import must resolve.
  spawn: () => { throw new Error('spawn not stubbed for this test') },
}))

describe('RuntimeManager cleanupStaleProcesses skips VM PIDs', () => {
  beforeEach(() => {
    _resetVMPidRegistry()
    killArgs.length = 0
    // Simulate one VM PID and one genuine stale PID, both
    // listening in the runtime cleanup range.
    lsofResponse = `${STALE_PID}\n${VM_PID}\n`
  })

  afterEach(() => {
    _resetVMPidRegistry()
  })

  it('skips a registered VM PID and still kills genuine stale PIDs', async () => {
    registerVMPid(VM_PID)

    // Constructing RuntimeManager invokes cleanupStaleProcesses.
    const { RuntimeManager } = await import('../manager')
    new RuntimeManager()

    // The stale PID must have reached a `kill -9 PID …` call.
    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${STALE_PID} `))).toBe(true)

    // The VM PID must NOT have been a kill target. This is the
    // single most important assertion in the file — its failure
    // means we've regressed the fix.
    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${VM_PID} `))).toBe(false)
  })

  it('control: kills both PIDs when neither is registered', async () => {
    // No registerVMPid() call. Both PIDs in the lsof output are
    // genuinely stale and must be killed. This catches a future
    // refactor that accidentally over-skips (e.g. flips the
    // `.has(pid)` polarity, or filters every PID unconditionally).
    const { RuntimeManager } = await import('../manager')
    new RuntimeManager()

    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${STALE_PID} `))).toBe(true)
    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${VM_PID} `))).toBe(true)
  })

  it('protects multiple VM PIDs simultaneously (pool size > 1 scenario)', async () => {
    const extraVmPid = 88888
    lsofResponse = `${STALE_PID}\n${VM_PID}\n${extraVmPid}\n`

    registerVMPid(VM_PID)
    registerVMPid(extraVmPid)

    const { RuntimeManager } = await import('../manager')
    new RuntimeManager()

    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${VM_PID} `))).toBe(false)
    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${extraVmPid} `))).toBe(false)
    expect(killArgs.some((cmd) => cmd.includes(`kill -9 ${STALE_PID} `))).toBe(true)
  })
})
