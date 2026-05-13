// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Platform-agnostic VM isolation layer.
 *
 * Each VM is the equivalent of a K8s pod: it runs a single agent-runtime
 * process in pool mode, exposes /health and /pool/assign via port forwarding.
 *
 * macOS: Go CLI wrapping Apple Virtualization.framework (VirtioFS + vsock)
 * Windows: Bundled QEMU with WHPX acceleration (9p + SLIRP)
 */

export interface VMConfig {
  workspaceDir: string
  credentialDirs: string[]
  /**
   * VM RAM ceiling in MB. With `virtio-balloon-pci,free-page-reporting=on`
   * the host will only resident-back the pages the guest actually
   * touches, capped at `memoryMB`. For pool right-sizing pass
   * `poolMemoryMB` (used as the initial balloon target) so warm-pool VMs
   * idle at the smaller footprint and grow to `memoryMB` on assign.
   */
  memoryMB: number
  cpus: number
  networkEnabled: boolean
  overlayPath: string
  vmImageDir: string
  /** Directory containing bun binary, agent-runtime bundle, shogo CLI, wasm files.
   *  Mounted read-only at /mnt/bundle inside the VM. */
  bundleDir?: string
  /** Desired host TCP port for the skill-server (default: auto via findFreePort) */
  skillServerHostPort?: number
  /** Extra environment variables to pass to the agent-runtime inside the VM */
  env?: Record<string, string>
  /**
   * Files to embed in the seed ISO (Windows pre-provisioned image path).
   * Keys are filenames (e.g. "server.js"), values are Buffer or string content.
   * Cloud-init copies them from the mounted ISO into /opt/shogo/.
   */
  bundleFiles?: Record<string, Buffer | string>
  /** Share workspaceDir into the VM via 9p mount instead of using the isolated overlay disk.
   *  When true, the guest `/workspace` (or `/host-workspaces` for warm pool) is a live view
   *  of the host directory. */
  mountWorkspace?: boolean
  /** Guest path for the 9p workspace mount. Defaults to `/workspace`.
   *  Set to `/host-workspaces` for warm pool VMs where the parent workspacesDir is shared. */
  workspaceMountPath?: string
  /**
   * Initial balloon target in MB for newly-booted VMs. When set and the
   * guest exposes a virtio-balloon device, the controller inflates the
   * balloon to (memoryMB - poolMemoryMB) on boot so pool VMs idle at
   * ~poolMemoryMB. The balloon is deflated back to `memoryMB` when the
   * pool VM is assigned to a project (via `VMManager.setBalloonTargetMB`).
   * Pass `undefined` to keep the historical fixed-size behaviour.
   */
  poolMemoryMB?: number
}

export interface VMHandle {
  id: string
  /** Host URL where the in-VM agent-runtime is reachable (e.g. http://localhost:39110) */
  agentUrl: string
  /** Host port where the in-VM skill-server is reachable (0 if not forwarded) */
  skillServerPort: number
  pid: number
  platform: 'darwin' | 'win32'
}

export interface VMManager {
  startVM(config: VMConfig): Promise<VMHandle>
  stopVM(handle: VMHandle): Promise<void>
  isRunning(handle: VMHandle): boolean
  forwardPort(handle: VMHandle, guestPort: number, hostPort: number): Promise<void>
  removeForward(handle: VMHandle, hostPort: number): Promise<void>
  /**
   * Adjust the guest's available memory via the virtio-balloon device.
   * `targetMB` is the **guest-visible** RAM size (i.e. how much memory
   * the guest is allowed to use). To shrink the guest from 4 GB to 1.5
   * GB, call `setBalloonTargetMB(handle, 1536)`. A no-op when the VM
   * was booted without a balloon device. Safe to call repeatedly.
   */
  setBalloonTargetMB?(handle: VMHandle, targetMB: number): Promise<void>
}

export const VM_DEFAULTS = {
  // 1.5 GB was too tight for an *assigned* VM: vite build --watch alone
  // reaches ~500 MB, plus bun agent-runtime (~300 MB), prisma generate
  // (~200 MB), TypeScript LSP and Pyright, and the kernel itself. The
  // Linux OOM killer was reaping `node` mid-build, causing preview-manager
  // restart loops. 4 GB gives headroom for all of the above plus a swapfile.
  memoryMB: 4096,
  // Idle warm-pool VMs don't run any of the above (LSP/vite/prisma start
  // lazily on /pool/assign). 1.5 GB is plenty for the kernel, bun
  // agent-runtime in pool mode, and a small workspace cache. On assign,
  // the controller deflates the balloon back to `memoryMB`.
  poolMemoryMB: 1536,
  cpus: 4,
  networkEnabled: true,

  /** Vsock port where the in-VM agent-runtime listens */
  agentVsockPort: 1,

  /** Vsock port where the in-VM skill-server bridge listens */
  skillVsockPort: 2,

  /** Default host TCP port to bridge the agent-runtime to */
  agentTcpPort: 39110,

  /** Port the agent-runtime listens on inside the VM */
  guestAgentPort: 8080,

  /** Port the skill-server listens on inside the VM */
  guestSkillPort: 4100,

  healthCheckRetries: 60,
  healthCheckIntervalMs: 500,
  shutdownTimeoutMs: 5000,

  portPollIntervalMs: 2000,
} as const
