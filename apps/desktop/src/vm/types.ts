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
}

export const VM_DEFAULTS = {
  memoryMB: 1536,
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
