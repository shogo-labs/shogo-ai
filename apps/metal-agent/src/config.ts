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

  /**
   * Public per-VM port-forwarding (the pre-mesh data path). When the control
   * plane can't route the private TAP guest IPs (e.g. OKE VCN-native pods that
   * only have internet egress), the node-agent DNATs a host public port to each
   * assigned guest's :guestPort and returns http://{publicHost}:{port} instead
   * of the private guest URL. Locked to `fwdAllowCidr` so only the control
   * plane's egress IP can reach the forwarded ports.
   *   publicHost empty → disabled (return the private guest URL, mesh mode).
   */
  publicHost: env('METAL_PUBLIC_HOST', ''),
  fwdPortBase: parseInt(env('METAL_FWD_PORT_BASE', '20000'), 10),
  fwdPortSpan: parseInt(env('METAL_FWD_PORT_SPAN', '1000'), 10),
  /** Source CIDR(s) allowed to reach forwarded ports, comma-sep. Empty = any. */
  fwdAllowCidr: env('METAL_FWD_ALLOW_CIDR', ''),

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
   * Balloon-reclaim before snapshot. Firecracker's CreateSnapshot writes the
   * whole guest RAM region; freed-but-stale pages don't gzip, so a mostly-idle
   * 4 GiB guest still yields a ~400 MiB mem.gz. Inflating the balloon just
   * before the snapshot makes FC `madvise(MADV_DONTNEED)` the reclaimed pages
   * (they snapshot as zeros and compress away). Measured on staging: mem.gz
   * 408 → 134 MiB (~3x) with a healthy restore. The guest comes back with the
   * balloon still inflated, so restoreVM() deflates it to hand RAM back.
   *
   * Reclaim is stats-guided: we read the balloon's available/free estimate and
   * target leaving `balloonFloorMiB` headroom, so we reclaim what's actually
   * free (fast) instead of forcing cache eviction / the driver's "out of puff"
   * retry spin. Requires balloon statistics, which must be enabled pre-boot
   * (see fc-api.machineConfig) — they cannot be turned on after InstanceStart.
   */
  balloonReclaim: env('METAL_SNAP_BALLOON', '1') !== '0',
  /** Guest headroom (MiB) to leave un-reclaimed during pre-snapshot inflate. */
  balloonFloorMiB: parseInt(env('METAL_SNAP_BALLOON_FLOOR_MB', '256'), 10),
  /**
   * Cap on how long to wait for inflation to settle before snapshotting. The
   * driver reclaims GiBs over several seconds; the stats-guided poll breaks
   * early on convergence/plateau so this is an upper bound, mostly hit only by
   * the no-stats blind-inflate path (older snapshots). Suspend is a background
   * op, so this latency isn't user-facing.
   */
  balloonMaxWaitMs: parseInt(env('METAL_SNAP_BALLOON_MAX_WAIT_MS', '10000'), 10),
  /** Poll interval while waiting for the balloon `actual` size to converge. */
  balloonPollMs: parseInt(env('METAL_SNAP_BALLOON_POLL_MS', '250'), 10),

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
   * Parallel ranged GET for large durable artifacts (the ~400 MiB compressed
   * mem image dominates an S3 hydration). A single stream to OCI's S3-compat
   * endpoint caps at ~27 MB/s (~15s for the mem); splitting the object into
   * `s3GetPartBytes` chunks fetched `s3GetConcurrency`-wide saturates the link.
   * Objects at/under one part are fetched in a single request. Set concurrency
   * to 1 (or part to 0) to disable and fall back to the single-stream GET.
   */
  s3GetPartBytes: parseInt(env('METAL_S3_GET_PART_MB', '16'), 10) * 1024 * 1024,
  s3GetConcurrency: parseInt(env('METAL_S3_GET_CONCURRENCY', '8'), 10),

  /**
   * Slim durable snapshots. The naive push is ~10 GB/project (full rootfs +
   * uncompressed guest RAM); at 10k projects that is ~100 TB in S3 and a
   * multi-GB download per cache miss. Slim mode shrinks that to ~1-2 GB:
   *   - mem is gzip-streamed to the store and decompressed on pull;
   *   - in dm rootfs mode the small CoW *diff* is pushed instead of the whole
   *     image, and the read-only golden base is uploaded once per rootfs
   *     identity (content-addressed under `basePrefix`) and reused by every
   *     project on that base.
   * Off by default (full artifacts). Requires host validation before prod.
   */
  snapSlim: env('METAL_SNAP_SLIM', '0') !== '0',
  /** Content-addressed prefix for the shared golden base(s) in the store. */
  snapBasePrefix: env('METAL_SNAP_BASE_PREFIX', 'metal-bases/'),
  /** Local cache dir for golden bases pulled from the store (diff-mode restore). */
  baseCacheDir: env('METAL_BASE_CACHE_DIR', `${WORK}/base-cache`),

  /**
   * Rootfs identity stamped into snapshot metadata. A restore is only valid
   * against a byte-compatible rootfs, so if the host's golden rootfs changed
   * (new runtime image / deps) the durable snapshot is stale and we cold-boot
   * instead. Empty → derived cheaply from baseRootfs size+mtime at startup.
   */
  rootfsIdentity: env('METAL_ROOTFS_IDENTITY', ''),

  // --- Phase 5: NVMe garbage collection / cache -----------------------------

  /**
   * Treat local NVMe as a bounded LRU cache of suspended snapshots, backed by
   * the durable store. A background sweep reclaims disk when it crosses the
   * high-water mark, evicting the least-recently-used *durably-backed* suspended
   * projects down to the low-water mark. Evicted projects still resume — they
   * pull from the durable store (a cache miss), so eviction is safe iff a
   * durable copy exists. Requires METAL_SNAP_STORE=fs|s3 to evict live
   * snapshots; with store=none the sweep only reclaims orphans.
   */
  gcIntervalMs: parseInt(env('METAL_GC_INTERVAL_MS', '30000'), 10),
  /** Start evicting when NVMe (METAL_WORK filesystem) crosses this used %. */
  diskHighPct: parseInt(env('METAL_DISK_HIGH_PCT', '85'), 10),
  /** Evict down to this used %. Must be < diskHighPct. */
  diskLowPct: parseInt(env('METAL_DISK_LOW_PCT', '70'), 10),
  /**
   * Optional absolute cap on the local snapshot cache (bytes). 0 = disabled
   * (watermarks only). When set, the sweep also evicts to keep cache bytes
   * under this ceiling regardless of overall disk %.
   */
  cacheMaxBytes: parseInt(env('METAL_CACHE_MAX_BYTES', '0'), 10),
  /**
   * Durable tiering: projects touched within this window keep a full live-RAM
   * snapshot in the durable store (fast wake). When a project OUTSIDE the window
   * is evicted locally, its durable snapshot is dropped too, so it falls back to
   * the git/S3 workspace cold boot on next open (keeps the durable tier small).
   * Default ~14 days.
   */
  durableActiveWindowMs: parseInt(env('METAL_DURABLE_ACTIVE_WINDOW_MS', String(14 * 24 * 60 * 60 * 1000)), 10),

  /**
   * Per-VM rootfs provisioning off the read-only golden image:
   *   full    → full copyFileSync (safe everywhere; ~8 GiB per VM)
   *   reflink → copy-on-write clone via COPYFILE_FICLONE (XFS reflink / Btrfs);
   *             only diverged blocks consume disk. Falls back to a full copy
   *             (with a warning) on a filesystem without reflink support.
   *   dm      → host-side device-mapper snapshot: one shared RO base + a small
   *             per-VM CoW store exposed as a single block device. Densest and
   *             the only mode whose diff is separable for slim durable pushes,
   *             but requires dmsetup/losetup on the host (see host-bootstrap.sh).
   */
  rootfsCow: env('METAL_ROOTFS_COW', 'reflink') as 'full' | 'reflink' | 'dm',
  /** dm mode: directory for per-VM CoW store files (sparse). */
  dmCowDir: env('METAL_DM_COW_DIR', `${WORK}/cow`),
  /** dm mode: per-VM CoW store size, sparse-allocated (e.g. "2G"). */
  dmCowSize: env('METAL_DM_COW_SIZE', '2G'),

  /**
   * Poll each assigned guest's /pool/activity on the reap interval to fold real
   * user traffic (which reaches the guest via DNAT, bypassing the node-agent)
   * into lastTouchedAt, so the idle reaper and GC never suspend/evict a project
   * that is actively serving requests. Fails open (treats a project as active on
   * poll failure) so we never evict on missing data.
   */
  activityPoll: env('METAL_ACTIVITY_POLL', '1') !== '0',
  activityTimeoutMs: parseInt(env('METAL_ACTIVITY_TIMEOUT_MS', '1000'), 10),
} as const

export type MetalConfig = typeof config

export function homeExpand(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p
}
