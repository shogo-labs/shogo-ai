// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Thin client for the Firecracker REST API, which is served over a Unix domain
 * socket. Bun's `fetch` speaks UDS natively via the `unix` option, so we don't
 * need curl or a socket shim.
 */

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

  machineConfig(vcpus: number, memMiB: number, ballooning = true) {
    return this.put('/machine-config', {
      vcpu_count: vcpus,
      mem_size_mib: memMiB,
      smt: false,
      track_dirty_pages: false,
    }).then(() =>
      ballooning
        ? this.put('/balloon', { amount_mib: 0, deflate_on_oom: true, stats_polling_interval_s: 0 })
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
    })
  }

  /** Adjust guest-visible RAM via virtio-balloon. `targetMiB` = desired guest RAM. */
  async setBalloon(targetMiB: number, configuredMiB: number) {
    // Balloon "amount" is how much to RECLAIM from the guest, i.e.
    // configured - target. Clamp to [0, configured].
    const amount = Math.max(0, Math.min(configuredMiB, configuredMiB - targetMiB))
    return this.patch('/balloon', { amount_mib: amount })
  }
}
