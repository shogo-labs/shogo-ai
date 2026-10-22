// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Process containment for every child this runtime starts (SHO-144).
 *
 * `task_cancel` used to report `cancelled` the moment a kill was *sent*. It had
 * no way to answer the only question that matters: is anything from that tree
 * still running?
 *
 * **Windows.** `taskkill /F /T /PID <shell>` walks parent PIDs, so it misses any
 * process whose in-between parent already exited — `merge.cmd`, the wrappers Git
 * Bash starts, `cmd /c start …`. Those were exactly the processes that kept
 * holding the merge lock for 24 minutes after `task_cancel` said it was clean.
 * A process started through an exiting wrapper inherits *nothing* from the pid
 * chain, but it does inherit a Job Object. Each contained child gets its own job
 * with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; killing the job kills every process
 * in it however it was started, and `ActiveProcesses` tells us when it is really
 * empty. The runtime also puts *itself* in a job ({@link installRuntimeJobGuard}),
 * so its death — SIGKILL, `TerminateProcess`, a crash — takes the execs, the API
 * sidecar and vite with it.
 *
 * **POSIX.** An exec must lead its own group (SHO-26), so `killProcessGroup(-runtime)`
 * cannot reach it. Each contained group is recorded in the child ledger
 * (`@shogo-ai/sdk/child-ledger`) and reaped by whoever outlives the runtime.
 * `killTree` here snapshots the group, signals it, and then says what is left.
 *
 * Known limit, documented rather than papered over: processes started through
 * WMI or the Task Scheduler escape every job, and a POSIX child that calls
 * `setsid` leaves its group. Both are reported as survivors when we saw them
 * before the kill; we never report `cancelled` for a tree we could not empty.
 */
import { spawnSync, type ChildProcess } from '@shogo/shared-runtime/child-process'
import {
  addChildLedgerEntry,
  commandFingerprint,
  removeChildLedgerEntry,
} from '@shogo-ai/sdk/child-ledger'

export interface ProcessMember {
  pid: number
  name: string
}

export interface KillTreeResult {
  /** Processes from the tree that are still alive after the kill. */
  survivors: ProcessMember[]
}

export interface KillTreeOptions {
  /** How long SIGTERM gets before SIGKILL. @default 2000 */
  graceMs?: number
}

export interface ContainmentOptions {
  /** Shown in the ledger and in log lines: `exec`, `api-sidecar`, `vite-watch`. */
  label: string
  /**
   * Where to record the group so a surviving supervisor can reap it. Omitted
   * for children whose lifetime is the runtime's own (a throwaway test spawn).
   */
  workspaceDir?: string
  /** Record the group in the POSIX ledger. @default Boolean(workspaceDir) */
  ledger?: boolean
  /** Test seam: replace the platform backend. */
  backend?: ContainmentBackend
}

export interface Containment {
  readonly label: string
  readonly pid: number | undefined
  /** Kill the whole tree, wait, then report what is still alive. */
  killTree(opts?: KillTreeOptions): Promise<KillTreeResult>
  /** Snapshot the tree, without killing it. */
  members(): ProcessMember[]
  /** Stop tracking. Does not kill; call `killTree` for that. */
  dispose(): void
}

export interface ContainmentBackend {
  members(): ProcessMember[]
  killTree(opts: KillTreeOptions): Promise<KillTreeResult>
  dispose(): void
}

const IS_WINDOWS = process.platform === 'win32'

/** How often the POSIX grace period re-checks whether the tree is gone. */
const GRACE_POLL_MS = 50

// ---------------------------------------------------------------------------
// POSIX: process-group snapshot + ledger
// ---------------------------------------------------------------------------

interface PsRow {
  pid: number
  pgid: number
  ppid: number
  command: string
}

function readProcessTable(): PsRow[] {
  let raw = ''
  try {
    raw = String(
      spawnSync('ps', ['-A', '-o', 'pid=,pgid=,ppid=,command='], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).stdout ?? '',
    )
  } catch {
    return []
  }
  const rows: PsRow[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    const pgid = Number(parts[1])
    const ppid = Number(parts[2])
    if (!Number.isFinite(pid) || !Number.isFinite(pgid) || !Number.isFinite(ppid)) continue
    rows.push({ pid, pgid, ppid, command: parts.slice(3).join(' ') })
  }
  return rows
}

function imageName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split(/[\\/]/).pop() ?? first
  return base || 'unknown'
}

/**
 * Members of the group `leader` leads, plus any descendant that left the group
 * (`setsid`, a wrapper that detached itself) — the ppid walk is what catches
 * those while the chain is still intact.
 */
function posixMembers(leader: number): ProcessMember[] {
  const rows = readProcessTable()
  if (rows.length === 0) return []
  const selected = new Map<number, PsRow>()
  for (const row of rows) {
    if (row.pgid === leader) selected.set(row.pid, row)
  }
  // Descendants by ppid, however they were reparented mid-walk.
  const queue = [leader]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const current = queue.pop() as number
    for (const row of rows) {
      if (row.ppid !== current || seen.has(row.pid)) continue
      seen.add(row.pid)
      selected.set(row.pid, row)
      queue.push(row.pid)
    }
  }
  selected.delete(leader)
  return [...selected.values()].map((row) => ({ pid: row.pid, name: imageName(row.command) }))
}

function signalGroup(leader: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-leader, signal)
  } catch {
    // ESRCH: the group already collapsed.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

/**
 * True while anything is still in group `pgid`. A `kill(2)` on the group, not a
 * `ps` — which is what makes it cheap enough to poll during a grace period.
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

/** A live process's command line, or `null` when it is gone. */
function readProcessCommand(pid: number): string | null {
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const command = String(out.stdout ?? '').trim()
    return command.length > 0 ? command : null
  } catch {
    return null
  }
}

class PosixContainment implements ContainmentBackend {
  /** Set when a kill left something alive: the entry must survive for a reaper. */
  private survivorsReported = false

  constructor(
    private readonly child: ChildProcess,
    private readonly label: string,
    private readonly workspaceDir?: string,
    private readonly recordLedger = Boolean(workspaceDir),
  ) {
    if (this.recordLedger && this.workspaceDir && this.child.pid) {
      // Fire-and-forget: capturing the fingerprint costs one `ps`, and the
      // spawn path must never wait for it. The window between spawn and the
      // entry landing is a few milliseconds; a crash inside it leaves nothing
      // recorded, which is the same as today.
      const pid = this.child.pid
      queueMicrotask(() => this.record(pid))
    }
  }

  /**
   * Record the group with the leader's *actual* command line, read back from
   * the process table. Recording the argv we asked for instead would make the
   * reaper's `ps` comparison a guess about quoting; this records exactly what
   * the reaper will compare against.
   */
  private record(pid: number): void {
    if (!this.workspaceDir) return
    const command = readProcessCommand(pid)
    if (!command) return
    try {
      addChildLedgerEntry(this.workspaceDir, {
        pgid: pid,
        pid,
        label: this.label,
        commandFingerprint: commandFingerprint(command),
        startedAt: Date.now(),
      })
    } catch {
      // A ledger write failure only costs us the reap of this one group.
    }
  }

  members(): ProcessMember[] {
    const leader = this.child.pid
    if (!leader) return []
    return posixMembers(leader)
  }

  async killTree(opts: KillTreeOptions = {}): Promise<KillTreeResult> {
    const leader = this.child.pid
    if (!leader) return { survivors: [] }
    const graceMs = opts.graceMs ?? 2_000

    const before = this.members()
    const leaderAlive = isAlive(leader)
    if (before.length === 0 && !leaderAlive) {
      // Nothing was running: the leader had already exited and left no group
      // behind. No second `ps`, no signal — the common case for a quick exec
      // (AC 4: a normal cancel stays one `ps` call).
      this.forget(leader)
      return { survivors: [] }
    }

    signalGroup(leader, 'SIGTERM')
    try { this.child.kill('SIGTERM') } catch { /* already gone */ }
    // Wait only as long as the tree actually needs: the common case is a shell
    // that exits immediately, and sleeping the whole grace period there made
    // every cancel pay 2 s it did not owe (Planner review, SHO-144).
    if (graceMs > 0 && !this.treeGone(leader)) await this.waitForTree(leader, graceMs)
    signalGroup(leader, 'SIGKILL')
    try { this.child.kill('SIGKILL') } catch { /* already gone */ }
    // Anything we saw before the kill that had left the group is signalled by
    // pid; it cannot be reached through the group id any more.
    for (const member of before) {
      try { process.kill(member.pid, 'SIGKILL') } catch { /* already gone */ }
    }

    const survivors = this.members().filter((member) => isAlive(member.pid))
    if (survivors.length === 0) {
      this.forget(leader)
    } else {
      // Leave the ledger entry alone: its fingerprint is what lets the next
      // reaper find these processes without guessing.
      this.survivorsReported = true
    }
    return { survivors }
  }

  /** True when the shell has exited and nothing is left in its group. */
  private treeGone(leader: number): boolean {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return !groupAlive(leader)
    return !isAlive(leader) && !groupAlive(leader)
  }

  /** Poll until the tree is gone, or the grace period runs out. */
  private async waitForTree(leader: number, graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if (this.treeGone(leader)) return
      await delay(Math.min(GRACE_POLL_MS, Math.max(1, deadline - Date.now())))
    }
  }

  private forget(leader: number): void {
    if (!this.workspaceDir) return
    try {
      removeChildLedgerEntry(this.workspaceDir, leader)
    } catch {
      // Best effort.
    }
  }

  dispose(): void {
    // A tree we could not empty keeps its ledger entry: that entry is the only
    // way a later reaper can find what we left behind.
    if (this.survivorsReported) return
    this.forget(this.child.pid ?? -1)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as any)?.unref?.()
  })
}

// ---------------------------------------------------------------------------
// Windows: one Job Object per tree
// ---------------------------------------------------------------------------

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
/**
 * `JobObjectBasicProcessIdList`. Deliberately not
 * `JobObjectBasicAccountingInformation` (class 1) for the ActiveProcesses count:
 * on windows-latest that query fails with ERROR_BAD_LENGTH (24) for a buffer
 * larger than the struct, so the poll never saw the job empty, burned its whole
 * budget and then guessed. The pid list answers the same question and, unlike a
 * count, names who is left.
 */
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64. */
const EXTENDED_LIMIT_INFO_BYTES = 144
/** `LimitFlags` sits after two LARGE_INTEGERs. */
const LIMIT_FLAGS_OFFSET = 16

interface Kernel32 {
  CreateJobObjectW(a: number, b: number): number
  SetInformationJobObject(job: number, infoClass: number, info: number, length: number): number
  AssignProcessToJobObject(job: number, processHandle: number): number
  TerminateJobObject(job: number, exitCode: number): number
  QueryInformationJobObject(job: number, infoClass: number, info: number, length: number, ret: number): number
  OpenProcess(access: number, inherit: number, pid: number): number
  CloseHandle(handle: number): number
}

const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_INFORMATION = 0x0400
/** Needed for AssignProcessToJobObject / TerminateJobObject. */
const JOB_PROCESS_ACCESS = PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION

let kernel32Promise: Promise<Kernel32 | null> | null = null

/**
 * Load kernel32 through `bun:ffi`.
 *
 * Deliberately dynamic: a static `import 'bun:ffi'` would be resolved (and
 * rejected) by every Node-side build and test runner, and the whole module is
 * dead weight off Windows. A `null` result means "no job objects on this
 * machine", and every caller falls back to `taskkill /T`.
 */
async function loadKernel32(): Promise<Kernel32 | null> {
  if (!IS_WINDOWS) return null
  if (kernel32Promise) return kernel32Promise
  kernel32Promise = (async () => {
    try {
      const specifier = 'bun:ffi'
      const ffi: any = await import(specifier)
      if (!ffi?.dlopen) return null
      const { ptr, i32 } = ffi.FFIType ?? {}
      if (!ptr || !i32) return null
      const lib = ffi.dlopen('kernel32.dll', {
        CreateJobObjectW: { args: [ptr, ptr], returns: ptr },
        SetInformationJobObject: { args: [ptr, i32, ptr, i32], returns: i32 },
        AssignProcessToJobObject: { args: [ptr, ptr], returns: i32 },
        TerminateJobObject: { args: [ptr, ptr], returns: i32 },
        QueryInformationJobObject: { args: [ptr, i32, ptr, i32, ptr], returns: i32 },
        OpenProcess: { args: [i32, i32, i32], returns: ptr },
        CloseHandle: { args: [ptr], returns: i32 },
      })
      return (lib?.symbols ?? null) as Kernel32 | null
    } catch {
      return null
    }
  })()
  return kernel32Promise
}

/** `taskkill /F /T /PID <pid>` — the pre-job fallback, and the AC-1 first move. */
function taskkillTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    })
  } catch {
    // taskkill missing, or the tree already collapsed.
  }
}

/** pid → image name for every process `tasklist` will report, parsed from CSV. */
function windowsProcessNames(): Map<number, string> {
  const names = new Map<number, string>()
  try {
    const raw = String(
      spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 10_000,
      }).stdout ?? '',
    )
    for (const line of raw.split(/\r?\n/)) {
      const cells = line.match(/"([^"]*)"/g)
      if (!cells || cells.length < 2) continue
      const name = cells[0].replace(/"/g, '')
      const pid = Number(cells[1].replace(/"/g, ''))
      if (Number.isFinite(pid) && pid > 0) names.set(pid, name)
    }
  } catch {
    // No names — the survivors are still reported, just without an image.
  }
  return names
}

function windowsTreesByPpid(rootPid: number): ProcessMember[] {
  const members: ProcessMember[] = []
  let raw = ''
  try {
    raw = String(
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 10_000 },
      ).stdout ?? '',
    )
  } catch {
    return members
  }
  let rows: Array<{ ProcessId?: number; ParentProcessId?: number; Name?: string }> = []
  try {
    const parsed = JSON.parse(raw || '[]')
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return members
  }
  const byParent = new Map<number, typeof rows>()
  for (const row of rows) {
    if (typeof row?.ParentProcessId !== 'number') continue
    const list = byParent.get(row.ParentProcessId) ?? []
    list.push(row)
    byParent.set(row.ParentProcessId, list)
  }
  const queue = [rootPid]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const current = queue.pop() as number
    for (const row of byParent.get(current) ?? []) {
      if (typeof row.ProcessId !== 'number' || seen.has(row.ProcessId)) continue
      seen.add(row.ProcessId)
      members.push({ pid: row.ProcessId, name: row.Name ?? 'unknown' })
      queue.push(row.ProcessId)
    }
  }
  return members
}

class WindowsContainment implements ContainmentBackend {
  private job: number | null = null
  private jobReady: Promise<void> | null = null
  private disposed = false
  /**
   * Set once a `killTree` pass has proved the job holds nothing else. A later
   * call — typically the teardown of whatever cancelled the task — must not
   * re-prove it: after `dispose()` there is no job left to query, so it would
   * fall through to the process table and pay for a `taskkill`, a `tasklist`
   * and a `Get-CimInstance` spawn to learn what it already knew.
   */
  private emptied = false
  /** The pass currently killing this tree, so a second caller joins it. */
  private killInFlight: Promise<KillTreeResult> | null = null

  constructor(private readonly child: ChildProcess, private readonly label: string) {
    const pid = child.pid
    if (!pid) return
    // The job must exist before the shell runs anything, so start the FFI load
    // now. Assignment itself happens as soon as kernel32 is available; until
    // then `killTree` leads with `taskkill /T`, which walks the parent chain
    // while it is still intact (see AC 1).
    this.jobReady = this.createJob(pid)
  }

  private async createJob(pid: number): Promise<void> {
    const k32 = await loadKernel32()
    if (!k32 || this.disposed) return
    try {
      const job = k32.CreateJobObjectW(0, 0)
      if (!job) return
      const info = Buffer.alloc(EXTENDED_LIMIT_INFO_BYTES)
      // KILL_ON_JOB_CLOSE and deliberately *not* BREAKAWAY_OK: a child that
      // could break away is a child that outlives its tree.
      info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET)
      // bun:ffi accepts a Buffer where the C signature wants a pointer.
      const ok = (k32.SetInformationJobObject as any)(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        info,
        EXTENDED_LIMIT_INFO_BYTES,
      )
      if (!ok) {
        k32.CloseHandle(job)
        return
      }
      const handle = k32.OpenProcess(JOB_PROCESS_ACCESS, 0, pid)
      if (!handle) {
        k32.CloseHandle(job)
        return
      }
      try {
        if (!((k32.AssignProcessToJobObject as any)(job, handle))) {
          k32.CloseHandle(job)
          return
        }
      } finally {
        k32.CloseHandle(handle)
      }
      this.job = job
    } catch {
      // Fall back to taskkill /T for this tree.
    }
  }

  members(): ProcessMember[] {
    const pid = this.child.pid
    if (!pid) return []
    return windowsTreesByPpid(pid)
  }

  /** Processes still assigned to the job per the kernel, or `null` if it would not say. */
  private jobProcessIds(k32: Kernel32, job: number): number[] | null {
    try {
      const buffer = Buffer.alloc(8 + 4096 * 8)
      const ok = (k32.QueryInformationJobObject as any)(
        job,
        JOB_OBJECT_BASIC_PROCESS_ID_LIST,
        buffer,
        buffer.length,
        0,
      )
      if (!ok) return null
      const count = buffer.readUInt32LE(4)
      const ids: number[] = []
      for (let i = 0; i < count; i++) {
        const pid = Number(buffer.readBigUInt64LE(8 + i * 8))
        if (pid > 0) ids.push(pid)
      }
      return ids
    } catch {
      return null
    }
  }

  async killTree(opts: KillTreeOptions = {}): Promise<KillTreeResult> {
    // Two callers ask at once: `handle.kill()` starts an unawaited sweep and
    // `TaskRegistry.cancel` awaits its own. A second pass used to race the first
    // over the same job handle — and `dispose()` (which the shell's exit fires)
    // nulled that handle mid-pass, so the loop polled a job that no longer
    // existed, `jobProcessIds` answered `[]` from a null handle, and the kill
    // reported an empty tree it had never verified. Single-flight it.
    if (this.killInFlight) return this.killInFlight
    if (this.emptied) return { survivors: [] }
    const run = this.killOnce(opts)
    const tracked = run.finally(() => {
      if (this.killInFlight === tracked) this.killInFlight = null
    })
    this.killInFlight = tracked
    return tracked
  }

  private async killOnce(opts: KillTreeOptions): Promise<KillTreeResult> {
    const pid = this.child.pid
    if (!pid) return { survivors: [] }
    const budgetMs = Math.max(2_000, opts.graceMs ?? 0)
    try { await this.jobReady } catch { /* fall back to taskkill */ }

    // taskkill first: it walks the parent chain, which is the only thing that
    // works for a tree whose job was never assigned (no FFI). Once the job is
    // terminated those children are gone anyway, so the order costs nothing.
    taskkillTree(pid)
    try { this.child.kill('SIGKILL') } catch { /* already gone */ }

    // Hold the handle for the whole pass: `this.job` goes null the moment
    // `dispose()` runs, which is exactly when the shell exits after `taskkill`.
    const job = this.job
    const k32 = job ? await loadKernel32() : null
    if (k32 && job) {
      const result = await this.terminateJobTree(k32, job, budgetMs)
      if (result) {
        if (result.survivors.length === 0) this.emptied = true
        return result
      }
      // The kernel would not answer, so the job cannot vouch for this tree:
      // fall through to the table walk rather than claim it is empty.
    }

    // No job object on this machine, or one already closed by `dispose()`:
    // verify through the process table. One spawn, not two — `members()` carries
    // the image names, and liveness is a syscall rather than a `tasklist` run.
    await delay(Math.min(budgetMs, 500))
    const survivors = this.members()
      .filter((member) => member.pid !== process.pid && isAlive(member.pid))
      .map((member) => ({ pid: member.pid, name: member.name }))
    if (survivors.length === 0) this.emptied = true
    return { survivors }
  }

  /**
   * Terminate the job and report what is left in it, or `null` when the kernel
   * would not answer — the caller must not call a tree empty on that.
   */
  private async terminateJobTree(
    k32: Kernel32,
    job: number,
    budgetMs: number,
  ): Promise<KillTreeResult | null> {
    let terminated = false
    try {
      terminated = Boolean((k32.TerminateJobObject as any)(job, 1))
    } catch {
      // Windows 7-era kernel32 without the symbol; taskkill already ran.
    }
    if (!terminated) return null

    // A pid still listed in the job's process list is alive: the kernel drops
    // terminated pids, so this poll is both the wait and the verdict.
    const deadline = Date.now() + budgetMs
    let remaining = this.jobProcessIds(k32, job)
    while (remaining !== null && remaining.length > 0 && Date.now() < deadline) {
      await delay(25)
      remaining = this.jobProcessIds(k32, job)
    }
    if (remaining === null) return null

    const survivors = remaining.filter((survivor) => survivor !== process.pid)
    if (survivors.length === 0) return { survivors: [] }
    const names = windowsProcessNames()
    return { survivors: survivors.map((pid) => ({ pid, name: names.get(pid) ?? 'unknown' })) }
  }

  dispose(): void {
    this.disposed = true
    // A KILL_ON_JOB_CLOSE handle would take the tree down on close, which is
    // wrong on a clean exit (`exec` that deliberately started a daemon). Disarm
    // the limit, then close.
    void this.disarm()
  }

  private async disarm(): Promise<void> {
    // Never surrender a tree a kill was told to take down: clearing
    // KILL_ON_JOB_CLOSE and closing the handle first is how a cancelled tree
    // survived its own cancel (SHO-144, 1 in 10 on windows-latest).
    if (this.killInFlight) {
      try { await this.killInFlight } catch { /* the caller saw the failure */ }
    }
    const job = this.job
    if (!job) return
    this.job = null
    const k32 = await loadKernel32()
    if (!k32) return
    try {
      const info = Buffer.alloc(EXTENDED_LIMIT_INFO_BYTES)
      ;(k32.SetInformationJobObject as any)(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, EXTENDED_LIMIT_INFO_BYTES)
    } catch {
      // Best effort; every process in it is already gone in the common case.
    }
    try {
      k32.CloseHandle(job)
    } catch {
      // Nothing left to close.
    }
  }
}

let runtimeJobHandle: number | null = null

/**
 * Put the runtime itself in a kill-on-close job (Windows only).
 *
 * The runtime is the only holder of the handle, so however its process ends —
 * `TerminateProcess` from the worker, jetsam, a crash — the kernel tears down
 * every descendant with it. Nested jobs are supported on Windows 8 and later;
 * the per-exec jobs above nest inside this one.
 *
 * Idempotent: a second call is a no-op, because the handle already *is* the
 * runtime's lifetime and creating another job would only add a second one.
 *
 * Never throws: without job objects the worker's `taskkill /T` fallback stays in
 * charge, which is exactly today's behaviour.
 */
export async function installRuntimeJobGuard(): Promise<boolean> {
  if (!IS_WINDOWS) return false
  if (runtimeJobHandle) return true
  const k32 = await loadKernel32()
  if (!k32) return false
  try {
    const job = k32.CreateJobObjectW(0, 0)
    if (!job) return false
    const info = Buffer.alloc(EXTENDED_LIMIT_INFO_BYTES)
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET)
    const ok = (k32.SetInformationJobObject as any)(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      info,
      EXTENDED_LIMIT_INFO_BYTES,
    )
    if (!ok) {
      k32.CloseHandle(job)
      return false
    }
    const handle = k32.OpenProcess(JOB_PROCESS_ACCESS, 0, process.pid)
    if (!handle) {
      k32.CloseHandle(job)
      return false
    }
    try {
      if (!((k32.AssignProcessToJobObject as any)(job, handle))) {
        k32.CloseHandle(job)
        return false
      }
    } finally {
      k32.CloseHandle(handle)
    }
    // The handle is deliberately never closed: it is the runtime's lifetime.
    runtimeJobHandle = job
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Take responsibility for a child process tree.
 *
 * Call immediately after `spawn` while the parent chain is still intact — that
 * is what makes the Windows `taskkill /T` first move reliable and what lets the
 * POSIX snapshot see a group that has not renamed itself yet.
 */
export function containChild(child: ChildProcess, opts: ContainmentOptions): Containment {
  const label = opts.label
  let inFlight: Promise<KillTreeResult> | null = null
  const backend: ContainmentBackend =
    opts.backend ??
    (IS_WINDOWS
      ? new WindowsContainment(child, label)
      : new PosixContainment(
          child,
          label,
          opts.workspaceDir,
          opts.ledger ?? Boolean(opts.workspaceDir),
        ))

  return {
    label,
    pid: child.pid,
    killTree: (killOpts?: KillTreeOptions) => {
      // One sweep at a time: `sendKill(SIGKILL)` starts this in the background
      // and the cancel path then awaits it. Sharing the in-flight promise is
      // what makes those one kill instead of two.
      if (!inFlight) {
        inFlight = backend
          .killTree(killOpts ?? {})
          .finally(() => { inFlight = null })
      }
      return inFlight
    },
    members: () => backend.members(),
    dispose: () => backend.dispose(),
  }
}

/** One-line advice for a human who has to finish what a kill could not. */
export function survivorHint(survivors: ProcessMember[]): string | undefined {
  if (survivors.length === 0) return undefined
  const pids = survivors.map((survivor) => survivor.pid).join(', ')
  return IS_WINDOWS
    ? `Still running: ${survivors.map((s) => `${s.name} (${s.pid})`).join(', ')}. Stop them with: Stop-Process -Id ${pids}`
    : `Still running: ${survivors.map((s) => `${s.name} (${s.pid})`).join(', ')}. Stop them with: kill -9 ${pids}`
}
