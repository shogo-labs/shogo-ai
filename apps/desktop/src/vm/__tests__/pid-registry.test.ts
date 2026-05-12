// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, beforeEach } from 'bun:test'
import {
  registerVMPid,
  unregisterVMPid,
  getRegisteredVMPids,
  _resetVMPidRegistry,
} from '../pid-registry'

describe('vm pid registry', () => {
  beforeEach(() => {
    _resetVMPidRegistry()
  })

  it('registers and reports a single PID', () => {
    registerVMPid(12345)
    const pids = getRegisteredVMPids()
    expect(pids.has(12345)).toBe(true)
    expect(pids.size).toBe(1)
  })

  it('unregisters a PID', () => {
    registerVMPid(12345)
    unregisterVMPid(12345)
    expect(getRegisteredVMPids().has(12345)).toBe(false)
  })

  it('tracks multiple concurrent VMs', () => {
    registerVMPid(100)
    registerVMPid(200)
    registerVMPid(300)
    const pids = getRegisteredVMPids()
    expect(pids.size).toBe(3)
    expect(pids.has(100)).toBe(true)
    expect(pids.has(200)).toBe(true)
    expect(pids.has(300)).toBe(true)
  })

  it('is idempotent on duplicate register', () => {
    registerVMPid(100)
    registerVMPid(100)
    registerVMPid(100)
    expect(getRegisteredVMPids().size).toBe(1)
  })

  it('is idempotent on unknown unregister', () => {
    expect(() => unregisterVMPid(99999)).not.toThrow()
    expect(getRegisteredVMPids().size).toBe(0)
  })

  it('silently rejects undefined PIDs (spawn failure case)', () => {
    // child_process.spawn() returns a ChildProcess whose `.pid` is
    // undefined when the kernel rejected the exec (ENOENT, EACCES,
    // ulimit hit, …). The registry must not crash and must not
    // pollute the set with bogus entries.
    registerVMPid(undefined)
    registerVMPid(null)
    registerVMPid(0)
    registerVMPid(-5)
    expect(getRegisteredVMPids().size).toBe(0)
  })

  it('silently rejects unregistering invalid PIDs', () => {
    registerVMPid(123)
    expect(() => unregisterVMPid(undefined)).not.toThrow()
    expect(() => unregisterVMPid(null)).not.toThrow()
    expect(() => unregisterVMPid(0)).not.toThrow()
    expect(getRegisteredVMPids().size).toBe(1)
    expect(getRegisteredVMPids().has(123)).toBe(true)
  })

  it('returned set reflects live state (callers can re-query each pass)', () => {
    // RuntimeManager.cleanupStaleProcesses calls getRegisteredVMPids()
    // once per cleanup pass. The returned reference should reflect
    // subsequent register/unregister calls within the same pass — if
    // it returned a snapshot copy, a VM spawned mid-cleanup could be
    // missed and SIGKILLed. (In practice cleanup is synchronous so
    // this is belt-and-braces, but worth pinning.)
    const snapshot = getRegisteredVMPids()
    expect(snapshot.size).toBe(0)
    registerVMPid(42)
    expect(snapshot.has(42)).toBe(true)
    expect(snapshot.size).toBe(1)
  })

  it('survives the documented warm-pool boot race scenario', () => {
    // Simulate: warm pool spawns QEMU (PID 75951), then ~1s later
    // RuntimeManager.cleanupStaleProcesses runs lsof and is about to
    // kill it. The registry must report PID 75951 so the cleanup
    // filter skips it. This is the exact bug observed in main.log
    // at 04:58:54.
    const qemuPid = 75951
    registerVMPid(qemuPid)

    // A typical lsof output, after numeric filtering. In the buggy
    // pre-fix code path, all three would have been passed to
    // `kill -9`. Now the VM PID must be filtered out.
    const lsofPids = ['46285', String(qemuPid), '46287']
    const vmPids = getRegisteredVMPids()
    const safeToKill = lsofPids.filter((p) => !vmPids.has(parseInt(p, 10)))

    expect(safeToKill).toEqual(['46285', '46287'])
    expect(safeToKill).not.toContain(String(qemuPid))
  })

  it('unregister on VM exit allows subsequent cleanup of dead VMs', () => {
    // After QEMU exits gracefully (or crashes), its PID is freed by
    // the kernel and may be recycled. The registry must release it
    // so a future legitimate stale-process cleanup can do its job.
    const pid = 88888
    registerVMPid(pid)
    expect(getRegisteredVMPids().has(pid)).toBe(true)
    unregisterVMPid(pid)
    expect(getRegisteredVMPids().has(pid)).toBe(false)
  })
})
