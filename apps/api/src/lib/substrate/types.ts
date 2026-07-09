// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * ProjectSubstrate — the ONE seam for "where and how does project P's runtime
 * live". It is the abstraction the metal cutover has been converging on: every
 * lifecycle operation that used to branch on `isKubernetes()` / metal-vs-knative
 * (resolve URL, status, wake, stop, destroy, resize, list) is promoted to this
 * interface so callers never re-implement the substrate cascade.
 *
 * Two production implementations satisfy it:
 *   - MetalSubstrate   (Firecracker microVMs on bare-metal hosts, via the
 *                       MetalWarmPoolController + node-agent HTTP API)
 *   - KnativeSubstrate (Knative ksvc + warm pool, via KnativeProjectManager)
 *
 * A router (`getProjectSubstrate`) picks the owner for a project id, mirroring
 * the metal-eligibility gate used by resolveProjectPodUrl. URL resolution for
 * the hot request path still flows through resolveProjectPodUrl (which keeps the
 * battle-tested drain/VM/host cascade); this interface owns the *lifecycle*
 * surface that was previously Knative-only or missing on metal, so a metal-only
 * world can delete the Knative code wholesale behind an unchanged contract.
 *
 * The reused Knative behavior tests run against BOTH implementations via
 * `__tests__/substrate-contract.test.ts` — that shared contract is the parity
 * proof.
 */

export type SubstrateKind = 'metal' | 'knative'

/** Runtime status of a project, substrate-agnostic (mirrors ProjectPodStatus). */
export interface RuntimeStatus {
  /** A runtime exists for this project (ksvc created / VM assigned or cached). */
  exists: boolean
  /** The runtime is up and serving right now. */
  ready: boolean
  /** Active replicas — metal: 1 when assigned, 0 when suspended/absent. */
  replicas: number
  /** Resolved runtime URL when known. */
  url?: string
  message?: string
}

export interface ResolveOpts {
  logTag?: string
  /** Keep waiting/retrying up to this long for the backend to become ready. */
  waitMs?: number
  retryDelayMs?: number
}

export interface WakeOpts {
  waitMs?: number
  retryDelayMs?: number
}

/** Resource overrides for `resize` (mirrors patchProjectResources). */
export interface Resources {
  cpu?: string
  memory?: string
  disk?: string
  minScale?: number
}

/** One project's runtime, for admin listing + infra metrics. */
export interface RuntimeSummary {
  projectId: string
  ready: boolean
  url?: string
  /** Owning host (metal hostId) when applicable. */
  host?: string
  region?: string
}

/**
 * Inputs for provisioning a project's LIVE published site ({subdomain}.shogo.one).
 * `serverBacked` is resolved by the caller (publish.ts probes /agent/server-info)
 * so the substrate never has to reach into the dev runtime — it just provisions
 * the right shape (static vs a long-running backend). `alwaysOn` pins a warm
 * replica (paid perk); otherwise the published runtime may scale/suspend to zero
 * and wake on visit.
 */
export interface PublishOpts {
  subdomain: string
  serverBacked: boolean
  alwaysOn?: boolean
}

/** Outcome of provisioning a published site. */
export interface PublishResult {
  /** The serving class that was provisioned. */
  serverBacked: boolean
  /** Which substrate now owns the published runtime. */
  substrate: SubstrateKind
  /** Cluster/mesh-routable URL of the published runtime, when one exists. */
  url?: string
}

export interface ProjectSubstrate {
  readonly kind: SubstrateKind

  /** Resolve the mesh/cluster-routable runtime URL, waking if needed. */
  resolveUrl(projectId: string, opts?: ResolveOpts): Promise<{ url: string }>

  /** Current runtime status without forcing a wake. */
  getStatus(projectId: string): Promise<RuntimeStatus>

  /** Ensure the runtime is up; never throws (returns `ready:false` on failure). */
  wake(projectId: string, opts?: WakeOpts): Promise<{ ready: boolean; url?: string }>

  /** Suspend / scale-to-zero (keeps the project resumable). Idempotent. */
  stop(projectId: string): Promise<void>

  /** Permanently tear the runtime down (VM+snapshot / ksvc+DomainMapping). */
  destroy(projectId: string): Promise<void>

  /** All projects with a runtime on this substrate (admin + metrics). */
  listAll(): Promise<RuntimeSummary[]>

  /**
   * Change a project's resources. Optional because not every substrate supports
   * per-project sizing: Knative patches the ksvc template; metal warm-pool VMs
   * are pool-uniform-sized today, so MetalSubstrate omits it and the router
   * surfaces a SubstrateUnsupportedError.
   */
  resize?(projectId: string, resources: Resources): Promise<void>

  // --- publishing surface --------------------------------------------------
  // The LIVE published site ({subdomain}.shogo.one), promoted to the substrate
  // interface so publish.ts stops branching on Knative directly. Static apps are
  // served entirely from PUBLISH_BUCKET + the Cloudflare Worker on BOTH
  // substrates (no runtime); only server-backed apps get a runtime here
  // (Knative published-{id} ksvc, or a metal published microVM).

  /**
   * Provision (or reconcile) the live published site for a project. Idempotent:
   * safe to call on every (re)publish. Static → no runtime; server-backed →
   * a long-running backend serving `/api/*`.
   */
  publish(projectId: string, opts: PublishOpts): Promise<PublishResult>

  /**
   * Tear down the published runtime + routing for a project. Idempotent and
   * best-effort (an already-unpublished project is a no-op). The durable
   * published-data archive is intentionally KEPT so a later republish restores
   * end-user writes.
   */
  unpublish(projectId: string, subdomain: string): Promise<void>

  /**
   * Ensure the published runtime is up, waking it from scale-to-zero / suspend
   * if needed. Never throws (returns `ready:false` on failure) so the visitor
   * loading page can keep polling. Static apps are always `ready:true`.
   */
  wakePublished(projectId: string, subdomain: string, opts?: WakeOpts): Promise<{ ready: boolean; url?: string }>

  /**
   * Flip the published runtime between always-on (pinned warm replica, no cold
   * start) and scale/suspend-to-zero. Best-effort; the DB flag is the source of
   * truth and the next republish reconciles. No-op for static apps.
   */
  setPublishedAlwaysOn(projectId: string, subdomain: string, on: boolean): Promise<void>
}

/** Thrown when an optional substrate operation isn't implemented for a kind. */
export class SubstrateUnsupportedError extends Error {
  constructor(
    public readonly op: string,
    public readonly kind: SubstrateKind,
  ) {
    super(`operation "${op}" is not supported on the ${kind} substrate`)
    this.name = 'SubstrateUnsupportedError'
  }
}
