// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { VMManager, VMConfig, VMHandle } from './types'

/**
 * Warm VM pool -- keeps one pre-booted VM idle so workspace opens are instant.
 *
 * Trade ~200 MB idle RAM for zero boot latency on the second workspace open.
 * The pool maintains at most one idle VM. When a workspace requests a VM,
 * the idle one is handed out immediately and a replacement starts booting
 * in the background.
 */
export class VMPool {
  private idleVM: { handle: VMHandle; config: VMConfig } | null = null
  private warming = false

  constructor(
    private manager: VMManager,
    private defaultConfig: VMConfig
  ) {}

  /**
   * Get a VM. If one is idle, returns it immediately.
   * Otherwise boots a new one (blocking).
   */
  async acquire(config?: Partial<VMConfig>): Promise<VMHandle> {
    const merged = { ...this.defaultConfig, ...config }

    if (this.idleVM && this.configCompatible(this.idleVM.config, merged)) {
      const vm = this.idleVM
      this.idleVM = null
      this.warmInBackground()
      return vm.handle
    }

    const handle = await this.manager.startVM(merged)
    this.warmInBackground()
    return handle
  }

  /**
   * Return a VM to the pool (stop it, don't reuse -- VMs are per-workspace).
   */
  async release(handle: VMHandle): Promise<void> {
    await this.manager.stopVM(handle)
  }

  /**
   * Pre-warm one VM in the background.
   */
  async warmInBackground(): Promise<void> {
    if (this.idleVM || this.warming) return
    this.warming = true

    try {
      const handle = await this.manager.startVM(this.defaultConfig)
      if (!this.idleVM) {
        this.idleVM = { handle, config: this.defaultConfig }
      } else {
        await this.manager.stopVM(handle)
      }
    } catch (err) {
      console.error('[VMPool] Failed to warm VM:', err)
    } finally {
      this.warming = false
    }
  }

  /**
   * Shut down any idle VMs.
   */
  async drain(): Promise<void> {
    if (this.idleVM) {
      await this.manager.stopVM(this.idleVM.handle)
      this.idleVM = null
    }
  }

  private configCompatible(a: VMConfig, b: VMConfig): boolean {
    return a.memoryMB === b.memoryMB && a.cpus === b.cpus && a.networkEnabled === b.networkEnabled
  }
}
