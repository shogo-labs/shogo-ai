// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pooled compute budget for a workspace on metal.
 *
 * A workspace buys one instance size, but every project it opens runs in its
 * own microVM. Without a budget, three docker projects in a Large workspace
 * are three 16 GiB VMs for one Large subscription. With it, the tier's memory
 * is shared by every VM the workspace has running: opening a project that
 * doesn't fit suspends the workspace's least-recently-opened idle VMs, and if
 * the rest are busy the open is refused with `WorkspaceCapacityError`.
 *
 * The running set in the placement registry is a cache. Before suspending
 * anything over it, each entry is confirmed against its host, because the
 * host's idle reaper suspends VMs without telling the API.
 */

import { INSTANCE_SIZES, getWorkspaceMemoryBudgetMiB, type InstanceSizeName } from '../config/instance-sizes'
import type { MetalPlacementRegistry, WorkspaceRun } from './metal-placement-registry'

export const WORKSPACE_BUDGET_SETTING_KEY = 'metal.workspace_budget_enabled'

let budgetOverride: boolean | null = null

export function getWorkspaceBudgetOverride(): boolean | null {
  return budgetOverride
}

export function setWorkspaceBudgetOverride(value: boolean | null): void {
  budgetOverride = value
}

/** True when metal admission enforces each workspace's pooled memory budget. */
export function isWorkspaceBudgetEnabled(): boolean {
  if (budgetOverride !== null) return budgetOverride
  return process.env.METAL_WORKSPACE_BUDGET_ENABLED === 'true'
}

/** Load the persisted override from `platform_settings` into memory. Call once at boot. */
export async function loadWorkspaceBudgetOverride(): Promise<void> {
  try {
    const { prisma } = await import('./prisma')
    const row = await prisma.platformSetting.findUnique({ where: { key: WORKSPACE_BUDGET_SETTING_KEY } })
    if (row) {
      budgetOverride = row.value === 'true'
      console.log(`[WorkspaceBudget] Loaded admin override: ${budgetOverride}`)
    }
  } catch (err: any) {
    console.log('[WorkspaceBudget] No override loaded (non-fatal):', err.message)
  }
}

export async function loadWorkspaceBudgetMiB(workspaceId: string): Promise<number> {
  const { prisma } = await import('./prisma')
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { instanceSize: true } })
  return getWorkspaceMemoryBudgetMiB((ws?.instanceSize ?? 'micro') as InstanceSizeName)
}

/** What an open did to the rest of the workspace, shown to the user once. */
export interface BudgetNotice {
  workspaceId: string
  suspendedProjectIds: string[]
  /** Runtimes running in the workspace after the open, including the opened one. */
  runningCount: number
  budgetMiB: number
}

/** The client-facing shape of a budget notice or refusal. */
export interface BudgetMessage {
  message: string
  instanceSize: string
  instanceLabel: string
  budgetGb: number
  runningCount: number
  projects: Array<{ id: string; name: string }>
  /** False on the top tier: there is nothing to upgrade to. */
  canUpgrade: boolean
}

const gb = (mib: number) => Math.round(mib / 1024)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const nameList = (projects: Array<{ name: string }>) => projects.map((p) => p.name).join(', ')

export function formatSleepNotice(
  notice: Pick<BudgetNotice, 'runningCount' | 'budgetMiB'>,
  slept: Array<{ id: string; name: string }>,
  tier: { size: InstanceSizeName; label: string },
): BudgetMessage {
  const canUpgrade = tier.size !== 'xlarge'
  const message =
    `Opening this project put ${plural(slept.length, 'other project')} to sleep (${nameList(slept)}). ` +
    `Your ${tier.label} workspace has ${gb(notice.budgetMiB)} GB for running projects, and ` +
    `${plural(notice.runningCount, 'project')} ${notice.runningCount === 1 ? 'is' : 'are'} running now. ` +
    (canUpgrade
      ? 'Upgrade your instance size to keep more projects running at once.'
      : 'Sleeping projects wake up when you open them again.')
  return {
    message,
    instanceSize: tier.size,
    instanceLabel: tier.label,
    budgetGb: gb(notice.budgetMiB),
    runningCount: notice.runningCount,
    projects: slept,
    canUpgrade,
  }
}

export function formatCapacityRefusal(
  err: Pick<WorkspaceCapacityError, 'budgetMiB' | 'blockedBy'>,
  busy: Array<{ id: string; name: string }>,
  tier: { size: InstanceSizeName; label: string },
): BudgetMessage {
  const canUpgrade = tier.size !== 'xlarge'
  const n = busy.length
  const message =
    `Your ${tier.label} workspace has ${gb(err.budgetMiB)} GB for running projects, and all of it is in use by ` +
    `${plural(n, 'busy project')} (${nameList(busy)}). Wait for ${n === 1 ? 'it' : 'them'} to finish or stop ` +
    (canUpgrade ? `${n === 1 ? 'it' : 'one'}, or upgrade your instance size to run more projects at once.` : `${n === 1 ? 'it' : 'one'}.`)
  return {
    message,
    instanceSize: tier.size,
    instanceLabel: tier.label,
    budgetGb: gb(err.budgetMiB),
    runningCount: n,
    projects: busy,
    canUpgrade,
  }
}

async function loadTierAndNames(
  workspaceId: string,
  projectIds: string[],
): Promise<{ tier: { size: InstanceSizeName; label: string }; projects: Array<{ id: string; name: string }> }> {
  const { prisma } = await import('./prisma')
  const [ws, rows] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { instanceSize: true } }),
    prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } }),
  ])
  const raw = (ws?.instanceSize ?? 'micro') as InstanceSizeName
  const size: InstanceSizeName = INSTANCE_SIZES[raw] ? raw : 'micro'
  const nameById = new Map(rows.map((r) => [r.id, r.name || 'Untitled project']))
  return {
    tier: { size, label: INSTANCE_SIZES[size].label },
    projects: projectIds.map((id) => ({ id, name: nameById.get(id) ?? 'Untitled project' })),
  }
}

/** Build the user-facing notice for an open that put other projects to sleep. */
export async function describeSleepNotice(notice: BudgetNotice): Promise<BudgetMessage> {
  const { tier, projects } = await loadTierAndNames(notice.workspaceId, notice.suspendedProjectIds)
  return formatSleepNotice(notice, projects, tier)
}

/** Build the user-facing message for an open refused by the budget. */
export async function describeCapacityRefusal(err: WorkspaceCapacityError): Promise<BudgetMessage> {
  const { tier, projects } = await loadTierAndNames(err.workspaceId, err.blockedBy.map((b) => b.projectId))
  return formatCapacityRefusal(err, projects, tier)
}

/** Runtime key → project id, for messages (`ws:proj:<id>` and bare ids). */
export function runtimeKeyProjectId(runtimeKey: string): string {
  return runtimeKey.startsWith('ws:proj:') ? runtimeKey.slice('ws:proj:'.length) : runtimeKey
}

export class WorkspaceCapacityError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly needMiB: number,
    readonly budgetMiB: number,
    /** Runtimes still holding the budget that could not be suspended. */
    readonly blockedBy: Array<{ projectId: string; memMiB: number; busy: boolean }>,
  ) {
    super(
      `workspace ${workspaceId} has no room for a ${needMiB} MiB runtime ` +
        `(budget ${budgetMiB} MiB, ${blockedBy.length} running project(s) could not be suspended)`,
    )
    this.name = 'WorkspaceCapacityError'
  }
}

export interface AdmissionDeps {
  registry: Pick<MetalPlacementRegistry, 'listWorkspaceRuns' | 'removeWorkspaceRun'>
  /** Host-side state of a runtime; null when no host holds it or the host didn't answer. */
  status: (runtimeKey: string) => Promise<{ state: 'assigned' | 'suspended' | 'none' } | null>
  /** Suspend a runtime to snapshot. */
  stop: (runtimeKey: string) => Promise<{ suspended: boolean; busy: boolean }>
  budgetMiB: number
  /** Upper bound on time spent suspending other runtimes before giving up. */
  deadlineMs?: number
  now?: () => number
  log?: (msg: string) => void
}

const DEFAULT_SHED_DEADLINE_MS = parseInt(process.env.METAL_WORKSPACE_SHED_DEADLINE_MS || '45000', 10)

/**
 * Make room for `runtimeKey` (needing `needMiB`) in the workspace's budget.
 * Resolves with the runtime keys it suspended; throws `WorkspaceCapacityError`
 * when the remaining running VMs are busy or would not suspend in time.
 *
 * A runtime that alone exceeds the budget (the unbilled mobile floor on a
 * micro workspace) is admitted once nothing else is running, so a workspace
 * can always run at least one project.
 */
export async function admitWorkspaceRuntime(
  workspaceId: string,
  runtimeKey: string,
  needMiB: number,
  deps: AdmissionDeps,
): Promise<{ suspended: string[]; runningCount: number }> {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((msg: string) => console.log(msg))
  const budget = deps.budgetMiB
  const tag = `[WorkspaceBudget] ws ${workspaceId.slice(0, 8)}`

  let runs: WorkspaceRun[] = (await deps.registry.listWorkspaceRuns(workspaceId)).filter(
    (r) => r.runtimeKey !== runtimeKey,
  )
  const used = () => runs.reduce((sum, r) => sum + r.memMiB, 0)
  const fits = () => used() + needMiB <= budget || runs.length === 0
  if (fits()) return { suspended: [], runningCount: runs.length + 1 }

  // Already running (cache expiry re-resolve, or a sibling replica admitted it):
  // it was counted when it started, so never refuse or shed around it.
  if ((await deps.status(runtimeKey).catch(() => null))?.state === 'assigned') {
    return { suspended: [], runningCount: runs.length + 1 }
  }

  // Drop entries the host no longer runs (idle-suspended, destroyed, moved).
  const states = await Promise.all(runs.map((r) => deps.status(r.runtimeKey).catch(() => null)))
  const gone = runs.filter((_, i) => states[i]?.state !== 'assigned')
  for (const r of gone) await deps.registry.removeWorkspaceRun(workspaceId, r.runtimeKey).catch(() => {})
  runs = runs.filter((_, i) => states[i]?.state === 'assigned')
  if (fits()) return { suspended: [], runningCount: runs.length + 1 }

  const deadline = now() + (deps.deadlineMs ?? DEFAULT_SHED_DEADLINE_MS)
  const suspended: string[] = []
  const blocked: Array<{ projectId: string; memMiB: number; busy: boolean }> = []
  for (const run of [...runs]) {
    if (fits()) break
    const remaining = deadline - now()
    if (remaining <= 0) {
      blocked.push({ projectId: runtimeKeyProjectId(run.runtimeKey), memMiB: run.memMiB, busy: false })
      continue
    }
    const res = await Promise.race([
      deps.stop(run.runtimeKey).catch(() => ({ suspended: false, busy: false })),
      new Promise<{ suspended: false; busy: false }>((r) =>
        setTimeout(() => r({ suspended: false, busy: false }), remaining).unref?.(),
      ),
    ])
    if (res.suspended) {
      await deps.registry.removeWorkspaceRun(workspaceId, run.runtimeKey).catch(() => {})
      runs = runs.filter((r) => r.runtimeKey !== run.runtimeKey)
      suspended.push(run.runtimeKey)
      log(`${tag} over budget — suspended ${run.runtimeKey} (${run.memMiB} MiB) to fit ${runtimeKey}`)
    } else {
      blocked.push({ projectId: runtimeKeyProjectId(run.runtimeKey), memMiB: run.memMiB, busy: res.busy })
    }
  }
  if (fits()) return { suspended, runningCount: runs.length + 1 }

  log(`${tag} refusing ${runtimeKey}: needs ${needMiB} MiB, ${used()}/${budget} MiB held by busy runtimes`)
  throw new WorkspaceCapacityError(workspaceId, needMiB, budget, blocked)
}
