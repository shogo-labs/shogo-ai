// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Node-agent configuration, resolved from the environment with sane defaults
 * for a bare-metal Linux host (the Latitude.sh pilot). Paths mirror the layout
 * that scripts/firecracker-spike/host-install.sh produces so the agent can run
 * against the exact artifacts the Phase 1 spike already validated.
 */

import { homedir } from 'os'

const env = (k: string, d: string) => process.env[k] ?? d

/** Where host-install.sh drops firecracker + kernel + rootfs. */
export const WORK = env('METAL_WORK', '/opt/fc-spike')

export const config = {
  work: WORK,
  fcBin: env('METAL_FC_BIN', `${WORK}/bin/firecracker`),
  kernel: env('METAL_KERNEL', `${WORK}/img/vmlinux`),
  /** Read-only golden rootfs. Each VM gets a writable per-VM copy. */
  baseRootfs: env('METAL_ROOTFS', `${WORK}/img/rootfs.ext4`),
  /** Scratch dir for per-VM sockets, rootfs copies, serial logs. */
  runDir: env('METAL_RUN', `${WORK}/run`),
  /** Where snapshots (vmstate + mem) are written. */
  snapDir: env('METAL_SNAP', `${WORK}/snapshots`),

  /** Guest port the pool-agent / agent-runtime listens on. */
  guestPort: parseInt(env('METAL_GUEST_PORT', '8080'), 10),

  /**
   * Optional kernel `init=` override. Empty = use the rootfs's default init
   * (systemd, for the baked agent-runtime image). For the pool-agent e2e we
   * point it at a tiny init that mounts /proc+/sys and execs the agent, which
   * bypasses systemd/networkd (so the kernel ip= config is never flushed) and
   * boots in tens of ms.
   */
  guestInit: env('METAL_GUEST_INIT', ''),

  /** Default microVM sizing. */
  vcpus: parseInt(env('METAL_VCPUS', '2'), 10),
  memMiB: parseInt(env('METAL_MEM_MIB', '1024'), 10),

  /** Warm pool target size. */
  poolSize: parseInt(env('METAL_POOL_SIZE', '1'), 10),

  /** Node-agent HTTP listen. */
  listenHost: env('METAL_LISTEN_HOST', '0.0.0.0'),
  listenPort: parseInt(env('METAL_LISTEN_PORT', '9900'), 10),

  /**
   * /30 base for per-VM point-to-point TAP subnets. VM N gets:
   *   host  = 172.16.(N*4 >> 8).(N*4 & 255)+1
   *   guest = ...+2
   * A /30 per VM keeps guests isolated from each other on the host.
   */
  tapCidrBase: env('METAL_TAP_BASE', '172.16.0.0'),

  /** Health probe tuning. */
  healthRetries: parseInt(env('METAL_HEALTH_RETRIES', '600'), 10),
  healthIntervalMs: parseInt(env('METAL_HEALTH_INTERVAL_MS', '50'), 10),

  /**
   * Mesh registration (Phase 2c/4). On startup the node-agent announces itself
   * to the control plane (apps/api) so `metal` pod-mode can route projects to
   * this host over the WireGuard mesh. All optional: with no controlPlaneUrl
   * the agent runs standalone (local e2e / pre-mesh).
   */
  controlPlaneUrl: env('METAL_CONTROL_PLANE_URL', ''),
  registerToken: env('METAL_REGISTER_TOKEN', ''),
  /** Stable host identity + the mesh IP the control plane should dial. */
  hostId: env('METAL_HOST_ID', process.env.HOSTNAME || 'metal-host'),
  meshIp: env('METAL_MESH_IP', env('METAL_LISTEN_HOST', '0.0.0.0')),
  region: env('METAL_REGION', 'us'),
  /** Re-announce interval (also serves as a liveness heartbeat). */
  registerIntervalMs: parseInt(env('METAL_REGISTER_INTERVAL_MS', '30000'), 10),

  // --- Phase 3: snapshot lifecycle ------------------------------------------

  /**
   * Suspend-on-idle. An assigned VM with no activity for this long is
   * quiesced + snapshotted (host RAM freed) by the reaper loop. 0 disables
   * auto-suspend (VMs stay resident until explicitly /suspend'd).
   */
  idleSuspendMs: parseInt(env('METAL_IDLE_SUSPEND_MS', '0'), 10),
  /** How often the reaper scans assigned VMs for idleness. */
  reapIntervalMs: parseInt(env('METAL_REAP_INTERVAL_MS', '15000'), 10),

  /**
   * Best-effort guest lifecycle hooks the node-agent calls around a
   * snapshot/restore so the in-guest runtime can flush + drop stale sockets
   * (AI-proxy/MCP/LSP/DB) before freeze and re-establish them after wake:
   *   POST {agentUrl}/pool/quiesce    (pre-snapshot)
   *   POST {agentUrl}/pool/rehydrate  (post-restore, once healthy)
   * A 404/timeout is tolerated (older guests / runtimes that opt out).
   */
  quiesceTimeoutMs: parseInt(env('METAL_QUIESCE_TIMEOUT_MS', '5000'), 10),
  rehydrateTimeoutMs: parseInt(env('METAL_REHYDRATE_TIMEOUT_MS', '5000'), 10),

  /**
   * Durable snapshot store. Local NVMe always holds the hot snapshot for
   * sub-second same-host resume; the store adds durability + cross-host
   * mobility (survives node-agent restart / lets another host wake a project).
   *   none → local-only (default; the Phase 2 behavior)
   *   fs   → copy artifacts to `snapStoreDir` (a separate/durable mount; also
   *          used by the lifecycle e2e to simulate off-host durability)
   *   s3   → OCI Object Storage (S3-compat) via Bun's built-in S3 client
   */
  snapStore: env('METAL_SNAP_STORE', 'none') as 'none' | 'fs' | 's3',
  snapStoreDir: env('METAL_SNAP_STORE_DIR', `${WORK}/durable-snapshots`),
  /** Key layout mirrors packages/shared-runtime/src/s3-sync.ts: `{prefix}{projectId}/...`. */
  snapStorePrefix: env('METAL_SNAP_PREFIX', 'metal-snapshots/'),
  snapStoreBucket: env('METAL_SNAP_BUCKET', env('S3_BUCKET', '')),
  s3Endpoint: env('S3_ENDPOINT', ''),
  s3Region: env('S3_REGION', 'us-east-1'),

  /**
   * Rootfs identity stamped into snapshot metadata. A restore is only valid
   * against a byte-compatible rootfs, so if the host's golden rootfs changed
   * (new runtime image / deps) the durable snapshot is stale and we cold-boot
   * instead. Empty → derived cheaply from baseRootfs size+mtime at startup.
   */
  rootfsIdentity: env('METAL_ROOTFS_IDENTITY', ''),
} as const

export type MetalConfig = typeof config

export function homeExpand(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p
}
