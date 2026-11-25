// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Declared services: the long-running processes a runtime should bring back by
 * itself (SHO-399).
 *
 * A recycle replaces the VM, so everything the agent started dies with it — and
 * `.tmp/` is not part of the backup (s3-sync drops it on purpose). Before this,
 * an agent that wanted a WhatsApp gateway or a cloudflared tunnel to survive had
 * no way to say so, and a task kept alive forever was the only alternative,
 * which is what pinned VMs off new releases in the first place.
 *
 * A service is `exec({ background: true, service: true })`. It is exempt from
 * the background-task cap, it does not block a release rotation (it comes back),
 * and it is restarted from this file on the next boot. The file lives under
 * `.shogo/` in the tree the runtime's SOURCE backup carries — the workspace
 * root for a project runtime, the anchor member for a workspace runtime, whose
 * root tree is in no backup (see {@link servicesDir}). Everything under
 * `.shogo/` except logs and task rows rides that archive, so the declaration
 * survives both a recycle and a cold boot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

/**
 * How many declared services one project may hold at once (SHO-509).
 *
 * A declared service is exempt from the 6 h cap and is restarted on every boot,
 * so it is the one kind of process that can outlive the work that needed it.
 * Three is enough for the real cases (an app, its API, a tunnel); beyond that a
 * declaration is a leak in waiting, and the refusal says which three are there.
 */
export const MAX_DECLARED_SERVICES = 3

export interface DeclaredService {
  /** Stable name; the only way to undeclare one is `task_cancel` on it. */
  name: string
  /** The exact command, as the agent ran it. */
  command: string
  /** Working directory it was started in, so a relative command still resolves. */
  cwd: string
  /** The chat session whose task list shows it (and whose registry owns it). */
  sessionId: string
  /** Epoch ms of the declaration; informational. */
  declaredAt: number
  /**
   * The card this service was declared for, when the session was working one
   * (SHO-509). A service whose card is Done or Dismissed is not restarted, and
   * is undeclared at boot instead — the leak that exhausted the process table.
   */
  workItemKey?: string
}

export function servicesFilePath(workspaceDir: string): string {
  return join(workspaceDir, '.shogo', 'services.json')
}

/**
 * Where the registry file lives, which is not always the workspace root.
 *
 * A workspace runtime's ROOT tree is in no backup: a recycle restores each
 * member's tree, the members' `data` and (when eligible) `home`, and nothing
 * else. A declaration written at the root would therefore be gone on the very
 * recycle it exists to survive — QA caught that on this card (SHO-399), and it
 * is exactly KIF's declared gateway. The anchor member's tree IS backed up
 * (source archive, which carries `.shogo/`), so write there.
 *
 * Every other runtime — and a workspace whose anchor member is not on disk —
 * keeps the root, which is what a project runtime's own source backup carries.
 */
export function servicesDir(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORKSPACE_RUNTIME !== 'true') return workspaceDir
  const anchor = env.WORKSPACE_ANCHOR_PROJECT_ID?.trim()
  if (!anchor) return workspaceDir
  const dir = join(workspaceDir, anchor)
  return existsSync(dir) ? dir : workspaceDir
}

/** Parse one registry file. Never throws. */
function readFrom(dir: string, workspaceDir: string): DeclaredService[] {
  try {
    const raw = readFileSync(servicesFilePath(dir), 'utf8')
    const parsed = JSON.parse(raw) as { services?: unknown }
    const list = Array.isArray(parsed?.services) ? parsed.services : []
    return list.filter((s): s is DeclaredService => {
      const svc = s as Partial<DeclaredService> | null
      return !!svc && typeof svc.name === 'string' && typeof svc.command === 'string'
    }).map((svc) => ({ ...svc, cwd: svc.cwd || workspaceDir, sessionId: svc.sessionId || '', declaredAt: svc.declaredAt || 0 }))
  } catch {
    return []
  }
}

/**
 * Every declared service, in declaration order. Never throws.
 *
 * An existing canonical file is authoritative even when it lists nothing —
 * that empty list IS how `task_cancel` undeclares a service. Falling back to a
 * root declaration whenever the canonical one is empty resurrected a cancelled
 * service on the next boot, so the fallback happens only when the canonical
 * file has never been written (QA, SHO-399).
 */
export function readDeclaredServices(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): DeclaredService[] {
  const dir = servicesDir(workspaceDir, env)
  if (existsSync(servicesFilePath(dir))) return readFrom(dir, workspaceDir)
  if (dir === workspaceDir) return []
  // A declaration written before the registry moved (or by a runtime whose
  // anchor was not mounted yet) is still honoured.
  return readFrom(workspaceDir, workspaceDir)
}

function writeTo(dir: string, services: DeclaredService[]): void {
  const path = servicesFilePath(dir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ services }, null, 2)}\n`, 'utf8')
  } catch (err: any) {
    console.error(`[services] could not write ${path}:`, err?.message ?? err)
  }
}

function write(workspaceDir: string, services: DeclaredService[]): void {
  writeTo(servicesDir(workspaceDir), services)
}

/** Add or replace a declaration (by name) and return the new list. */
export function declareService(workspaceDir: string, service: DeclaredService): DeclaredService[] {
  const next = readDeclaredServices(workspaceDir).filter((s) => s.name !== service.name)
  next.push(service)
  write(workspaceDir, next)
  return next
}

/**
 * Remove a declaration by name. Returns whether one was there.
 *
 * It clears the name from EVERY registry file the runtime can see, not just the
 * canonical one: a runtime that declared services before the registry moved to
 * the anchor member still has a root file, and leaving it behind meant a
 * cancelled service came back on the next boot (QA, SHO-399).
 */
export function undeclareService(workspaceDir: string, name: string): boolean {
  const canonical = servicesDir(workspaceDir)
  const current = readDeclaredServices(workspaceDir)
  const kept = current.filter((s) => s.name !== name)
  let removed = kept.length !== current.length
  if (removed) writeTo(canonical, kept)
  if (canonical !== workspaceDir && existsSync(servicesFilePath(workspaceDir))) {
    const legacy = readFrom(workspaceDir, workspaceDir)
    const legacyKept = legacy.filter((s) => s.name !== name)
    if (legacyKept.length !== legacy.length) {
      removed = true
      writeTo(workspaceDir, legacyKept)
    }
  }
  return removed
}

/**
 * A default name for a service that did not get one: the program, plus the
 * script/module it runs when the command names one (`bun wa-gateway.ts` →
 * `bun wa-gateway.ts`). Two declarations of the same command replace each
 * other, which is what an agent re-running its gateway wants.
 */
export function deriveServiceName(command: string): string {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const program = words[0] ? basename(words[0]) : 'service'
  const target = words[1] && !words[1].startsWith('-') ? basename(words[1]) : ''
  return target ? `${program} ${target}` : program
}

/**
 * The port a command asks for, when it names one: `--port 8081`, `-p 8081`,
 * `PORT=8081`, `--port=8081`. Used to treat "the same service under another
 * name" as the same service — Dev 2's `sho476-e2e-web` and `-web2` were both
 * `dev:web -- --port 8081`, and both were restarted on every boot.
 */
export function servicePort(command: string): number | undefined {
  const patterns = [
    /(?:^|\s)--port[=\s]+(\d{2,5})(?=\s|$)/,
    /(?:^|\s)PORT=(\d{2,5})(?=\s|$)/,
    /(?:^|\s)-p[=\s]+(\d{2,5})(?=\s|$)/,
  ]
  for (const pattern of patterns) {
    const match = command.match(pattern)
    if (!match) continue
    const port = Number(match[1])
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  }
  return undefined
}

/** Same command, run from the same place — whatever the agent called it. */
export function sameServiceTarget(a: Pick<DeclaredService, 'command' | 'cwd'>, b: Pick<DeclaredService, 'command' | 'cwd'>): boolean {
  return a.command.replace(/\s+/g, ' ').trim() === b.command.replace(/\s+/g, ' ').trim()
    && (a.cwd || '') === (b.cwd || '')
}

export function humanServiceAge(declaredAt: number, now = Date.now()): string {
  if (!declaredAt) return 'age unknown'
  const minutes = Math.round(Math.max(0, now - declaredAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const days = Math.floor(minutes / (60 * 24))
  if (days >= 1) return `${days}d`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** One declared service, as a refusal lists it. */
export function describeDeclaredService(service: DeclaredService, now = Date.now()): string {
  const card = service.workItemKey ? `, card ${service.workItemKey}` : ''
  return `\`${service.name}\` → \`${service.command}\` (declared ${humanServiceAge(service.declaredAt, now)}${card})`
}

export interface ServiceDeclarationPlan {
  /**
   * `replace` when this declaration supersedes an existing one (same name, same
   * command and cwd, or the same port): the caller must stop that tree first.
   * `refuse` when the project is at {@link MAX_DECLARED_SERVICES}.
   */
  action: 'add' | 'replace' | 'refuse'
  /** The entry this declaration supersedes. Its tree has to be killed first. */
  replaced?: DeclaredService
  /** Why the declaration was refused, in the agent's words. */
  error?: string
  /** The declaration to write on `add` / `replace`. */
  service: DeclaredService
}

/**
 * Decide what a new declaration does to the ones already on record (SHO-509).
 *
 * Three of the four rules exist because the old behaviour was "append": two
 * `expo dev:web --port 8081` entries under different names fought for one port
 * and both came back after a restart. Identity is the name, the command+cwd,
 * or the port — any of the three means the agent wants THIS service, not a
 * second copy of it.
 */
export function planServiceDeclaration(
  existing: DeclaredService[],
  candidate: DeclaredService,
  now = Date.now(),
  limit = MAX_DECLARED_SERVICES,
): ServiceDeclarationPlan {
  const byName = existing.find((service) => service.name === candidate.name)
  if (byName) return { action: 'replace', replaced: byName, service: candidate }

  const byTarget = existing.find((service) => sameServiceTarget(service, candidate))
  if (byTarget) return { action: 'replace', replaced: byTarget, service: candidate }

  const port = servicePort(candidate.command)
  if (port !== undefined) {
    const byPort = existing.find((service) => servicePort(service.command) === port)
    if (byPort) return { action: 'replace', replaced: byPort, service: candidate }
  }

  if (existing.length >= limit) {
    return {
      action: 'refuse',
      service: candidate,
      error:
        `This project already has ${existing.length} declared services (the cap is ${limit}): ` +
        `${existing.map((service) => describeDeclaredService(service, now)).join('; ')}. ` +
        'A declared service is exempt from the 6 h cap and comes back on every restart, so a fourth one is a ' +
        'process leak. Cancel one with `task_cancel({ task_id })` (that undeclares it too), or run this as a ' +
        'background job (`background: true` without `service: true`) if it only needs to outlive this turn.',
    }
  }
  return { action: 'add', service: candidate }
}

/** Write the plan's outcome, dropping the superseded entry. */
export function applyServiceDeclaration(workspaceDir: string, plan: ServiceDeclarationPlan): DeclaredService[] {
  if (plan.replaced && plan.replaced.name !== plan.service.name) {
    undeclareService(workspaceDir, plan.replaced.name)
  }
  return declareService(workspaceDir, plan.service)
}

/**
 * Collapse declarations that are the same service under different names, and
 * return the names dropped.
 *
 * Registry files written before this rule existed still hold them (Dev 1 had
 * two identical `expo dev:web --port 8081` entries, Dev 2 two `sho476-e2e-web*`
 * on one port), and every one of them was restarted on every boot. Kept is the
 * newest declaration of each identity — the one whose agent ran it last.
 */
export function dedupeDeclaredServices(workspaceDir: string): string[] {
  const services = readDeclaredServices(workspaceDir)
  if (services.length < 2) return []
  const kept: DeclaredService[] = []
  const dropped: string[] = []
  for (const service of [...services].sort((a, b) => (b.declaredAt || 0) - (a.declaredAt || 0))) {
    const port = servicePort(service.command)
    const duplicate = kept.find((other) =>
      sameServiceTarget(other, service) || (port !== undefined && servicePort(other.command) === port))
    if (duplicate) dropped.push(service.name)
    else kept.push(service)
  }
  if (dropped.length === 0) return []
  for (const name of dropped) undeclareService(workspaceDir, name)
  return dropped
}

/** A service command that points into `.tmp/` will not survive a recycle. */
export function serviceTmpWarning(command: string): string | undefined {
  if (!/(^|[\s'"=:(])\.tmp\//.test(command)) return undefined
  return '`.tmp/` is not kept across a recycle; move the script and its env file into the project.'
}

/** Single-quote a path for a POSIX shell (a cwd may contain spaces or quotes). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
