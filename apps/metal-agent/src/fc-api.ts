// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Thin client for the Firecracker REST API, which is served over a Unix domain
 * socket. Bun's `fetch` speaks UDS natively via the `unix` option, so we don't
 * need curl or a socket shim.
 */

/** Subset of Firecracker's BalloonStats we act on (sizes in MiB / bytes). */
export interface BalloonStats {
  /** Balloon target size (MiB) — how much RAM is currently reclaimed. */
  targetMib: number
  /** Balloon actual size (MiB) — how much the driver has really handed back. */
  actualMib: number
  /** Guest estimate of memory available for new work without swapping (MiB). */
  availableMib: number
  /** Guest truly-free memory (MiB). */
  freeMib: number
}

/**
 * Pick how many MiB to reclaim via the balloon before a snapshot.
 *
 * We reclaim what the guest reports as *available* (free + easily-reclaimable
 * cache) while leaving `floorMiB` of headroom, and never target more than the
 * guest could give back (`configuredMiB - floorMiB`). Targeting only reclaimable
 * memory keeps inflation fast and avoids the driver's "out of puff" retry spin
 * that happens when the target is unreachable. Pure + unit-tested.
 */
export function computeReclaimMiB(args: {
  configuredMiB: number
  availableMiB: number
  floorMiB: number
}): number {
  const { configuredMiB, availableMiB, floorMiB } = args
  const ceiling = Math.max(0, configuredMiB - Math.max(0, floorMiB))
  const reclaimable = Math.max(0, availableMiB - Math.max(0, floorMiB))
  return Math.max(0, Math.min(ceiling, reclaimable))
}

export class FcApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`FC ${method} ${path} -> ${status}: ${body}`)
    this.name = 'FcApiError'
  }
}

export class FcApi {
  constructor(private socketPath: string) {}

  private async req(method: string, path: string, body?: unknown): Promise<void> {
    const res = await fetch(`http://localhost${path}`, {
      // @ts-expect-error - Bun-specific: route this fetch over a Unix socket.
      unix: this.socketPath,
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok && res.status !== 204) {
      throw new FcApiError(method, path, res.status, await res.text().catch(() => ''))
    }
  }

  put(path: string, body: unknown) {
    return this.req('PUT', path, body)
  }
  patch(path: string, body: unknown) {
    return this.req('PATCH', path, body)
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`http://localhost${path}`, {
      // @ts-expect-error - Bun-specific: route this fetch over a Unix socket.
      unix: this.socketPath,
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new FcApiError('GET', path, res.status, await res.text().catch(() => ''))
    return (await res.json()) as T
  }

  // --- Typed convenience wrappers over the FC API surface we use. ---

  bootSource(kernelImagePath: string, bootArgs: string) {
    return this.put('/boot-source', { kernel_image_path: kernelImagePath, boot_args: bootArgs })
  }

  rootDrive(pathOnHost: string, readOnly = false) {
    return this.put('/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: pathOnHost,
      is_root_device: true,
      is_read_only: readOnly,
    })
  }

  /**
   * Configure vCPUs + RAM and (optionally) install the balloon device.
   * `statsIntervalS > 0` enables balloon statistics so pre-snapshot reclaim can
   * poll the guest's available/actual sizes — this MUST be set pre-boot, FC
   * refuses to enable stats after InstanceStart. `ballooning=false` skips the
   * device entirely.
   */
  machineConfig(vcpus: number, memMiB: number, ballooning = true, statsIntervalS = 0) {
    return this.put('/machine-config', {
      vcpu_count: vcpus,
      mem_size_mib: memMiB,
      smt: false,
      track_dirty_pages: false,
    }).then(() =>
      ballooning
        ? this.put('/balloon', {
            amount_mib: 0,
            deflate_on_oom: true,
            stats_polling_interval_s: Math.max(0, Math.floor(statsIntervalS)),
          })
        : undefined,
    )
  }

  networkInterface(ifaceId: string, hostDevName: string, guestMac?: string) {
    return this.put(`/network-interfaces/${ifaceId}`, {
      iface_id: ifaceId,
      host_dev_name: hostDevName,
      ...(guestMac ? { guest_mac: guestMac } : {}),
    })
  }

  instanceStart() {
    return this.put('/actions', { action_type: 'InstanceStart' })
  }

  pause() {
    return this.patch('/vm', { state: 'Paused' })
  }
  resume() {
    return this.patch('/vm', { state: 'Resumed' })
  }

  /** Full snapshot: vmstate + guest memory to two files. VM must be Paused. */
  createSnapshot(snapshotPath: string, memFilePath: string) {
    return this.put('/snapshot/create', {
      snapshot_type: 'Full',
      snapshot_path: snapshotPath,
      mem_file_path: memFilePath,
    })
  }

  /** Load a snapshot into a fresh FC process and (optionally) resume it. */
  loadSnapshot(snapshotPath: string, memFilePath: string, resume = true) {
    return this.put('/snapshot/load', {
      snapshot_path: snapshotPath,
      mem_backend: { backend_path: memFilePath, backend_type: 'File' },
      enable_diff_snapshots: false,
      resume_vm: resume,
      // Advance the guest wall-clock to the host's real time on restore.
      // Without this, a restored guest resumes with the clock frozen at
      // snapshot-creation time; after a suspend of more than a few minutes the
      // guest clock is far enough in the past that outbound TLS handshakes fail
      // with "certificate is not yet valid" (notBefore in the future relative
      // to the stale clock), breaking every HTTPS call from the guest
      // (AI proxy, Composio, etc.). Requires kvm-clock (the x86 KVM default;
      // our guests set no `clocksource=`) and host kernel >= 5.16 (hosts run 6.8).
      clock_realtime: true,
    })
  }

  /** Adjust guest-visible RAM via virtio-balloon. `targetMiB` = desired guest RAM. */
  async setBalloon(targetMiB: number, configuredMiB: number) {
    // Balloon "amount" is how much to RECLAIM from the guest, i.e.
    // configured - target. Clamp to [0, configured].
    const amount = Math.max(0, Math.min(configuredMiB, configuredMiB - targetMiB))
    return this.patch('/balloon', { amount_mib: amount })
  }

  /** Set the balloon target directly (MiB to reclaim from the guest). */
  balloonInflate(amountMiB: number) {
    return this.patch('/balloon', { amount_mib: Math.max(0, Math.floor(amountMiB)) })
  }

  /** Return all reclaimed RAM to the guest (balloon target → 0). */
  balloonDeflate() {
    return this.patch('/balloon', { amount_mib: 0 })
  }

  /**
   * Read balloon statistics (requires stats enabled pre-boot). Returns null if
   * stats are disabled or the device is absent, so callers can skip reclaim
   * rather than fail a snapshot. `free_memory`/`available_memory` are bytes.
   */
  async balloonStats(): Promise<BalloonStats | null> {
    try {
      const s = await this.get<{
        target_mib?: number
        actual_mib?: number
        available_memory?: number
        free_memory?: number
      }>('/balloon/statistics')
      return {
        targetMib: s.target_mib ?? 0,
        actualMib: s.actual_mib ?? 0,
        availableMib: Math.floor((s.available_memory ?? 0) / (1024 * 1024)),
        freeMib: Math.floor((s.free_memory ?? 0) / (1024 * 1024)),
      }
    } catch {
      return null
    }
  }
}
