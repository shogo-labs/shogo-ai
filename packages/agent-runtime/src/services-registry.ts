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
 * and it is restarted from this file on the next boot. `.shogo/services.json`
 * lives under `.shogo/`, which IS in the source backup, so the declaration
 * survives both a recycle and a cold boot (only `.shogo/logs/` and
 * `.shogo/tasks/` are dropped).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

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
}

export function servicesFilePath(workspaceDir: string): string {
  return join(workspaceDir, '.shogo', 'services.json')
}

/** Every declared service, in declaration order. Never throws. */
export function readDeclaredServices(workspaceDir: string): DeclaredService[] {
  try {
    const raw = readFileSync(servicesFilePath(workspaceDir), 'utf8')
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

function write(workspaceDir: string, services: DeclaredService[]): void {
  const path = servicesFilePath(workspaceDir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ services }, null, 2)}\n`, 'utf8')
  } catch (err: any) {
    console.error(`[services] could not write ${path}:`, err?.message ?? err)
  }
}

/** Add or replace a declaration (by name) and return the new list. */
export function declareService(workspaceDir: string, service: DeclaredService): DeclaredService[] {
  const next = readDeclaredServices(workspaceDir).filter((s) => s.name !== service.name)
  next.push(service)
  write(workspaceDir, next)
  return next
}

/** Remove a declaration by name. Returns whether one was there. */
export function undeclareService(workspaceDir: string, name: string): boolean {
  const before = readDeclaredServices(workspaceDir)
  const next = before.filter((s) => s.name !== name)
  if (next.length === before.length) return false
  write(workspaceDir, next)
  return true
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

/** A service command that points into `.tmp/` will not survive a recycle. */
export function serviceTmpWarning(command: string): string | undefined {
  if (!/(^|[\s'"=:(])\.tmp\//.test(command)) return undefined
  return '`.tmp/` is not kept across a recycle; move the script and its env file into the project.'
}

/** Single-quote a path for a POSIX shell (a cwd may contain spaces or quotes). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
