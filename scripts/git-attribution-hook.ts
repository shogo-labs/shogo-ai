// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The implementation behind the tracked `.githooks/` identity and co-author
 * guards. The hooks are the enforcement point: they see every commit in a
 * checkout, including the ones no caller-side argument rewriting can reach
 * (`bash -c`, a repo script, `xargs git commit`, an editor session).
 *
 *   commit-msg <file>  fold every Shogo co-author into the one canonical
 *                      `Co-authored-by:` trailer (agent-authored commits only)
 *   verify-commit      refuse an author/committer that is not the agent identity
 *   verify-push        refuse to send any commit that is not the agent identity
 *
 * Both guards are armed only in an agent checkout — one whose local
 * `user.email` is a Shogo agent address (`agentIdentityFromConfig`). A human's
 * checkout of this repo is never refused and never gets a trailer added.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  agentIdentityFromConfig,
  isCanonicalShogoAgentIdentity,
  isShogoAgentIdentity,
  normalizeAgentAttribution,
  shogoCoAuthorTrailer,
  type AgentIdentity,
} from '../packages/shared-runtime/src/agent-attribution'

type Mode = 'commit-msg' | 'verify-commit' | 'verify-push'

interface Identity {
  name: string
  email: string
}

const IDENT_RE = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/

/**
 * `git commit` captures a hook's stdout/stderr and only replays them when the
 * hook fails, so a successful normalization has to talk to the terminal itself
 * to be seen. Silent when there is no terminal (CI, tests, a script).
 */
function notice(message: string): void {
  if (!process.stderr.isTTY) return
  try {
    writeFileSync('/dev/tty', `${message}\n`)
  } catch {
    console.error(message)
  }
}

function git(args: string[], stdin?: string): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      input: stdin,
    }).trimEnd()
  } catch {
    return null
  }
}

function parseIdent(value: string | null): Identity | null {
  if (!value) return null
  const match = IDENT_RE.exec(value.trim())
  return match ? { name: match[1]!, email: match[2]! } : null
}

function identFromEnv(kind: 'AUTHOR' | 'COMMITTER'): Identity | null {
  const name = process.env[`GIT_${kind}_NAME`]
  const email = process.env[`GIT_${kind}_EMAIL`]
  if (!name && !email) return null
  return { name: name ?? '', email: email ?? '' }
}

function currentIdent(kind: 'AUTHOR' | 'COMMITTER'): Identity | null {
  return parseIdent(git(['var', `GIT_${kind}_IDENT`])) ?? identFromEnv(kind)
}

/** The identity this checkout commits as, or `null` for a human's checkout. */
function agentCheckout(): AgentIdentity | null {
  // Local config first: `git -c user.email=…` (and an env override) shadows the
  // effective value inside a hook, so arming on the effective value alone would
  // let it be disarmed from the commit command itself.
  const local = agentIdentityFromConfig(git(['config', '--local', '--get', 'user.email']))
  if (local) return local
  return agentIdentityFromConfig(git(['config', '--get', 'user.email']))
}

/** Any Shogo identity — used to repair a trailer that already names one. */
function isShogoIdentity(identity: Identity | null): boolean {
  return !!identity && isShogoAgentIdentity(identity.name, identity.email)
}

/** The one identity a commit may carry in an agent checkout. */
function isAgent(identity: Identity | null): boolean {
  return !!identity && isCanonicalShogoAgentIdentity(identity.name, identity.email)
}

function describe(identity: Identity | null): string {
  if (!identity) return 'an unknown identity'
  return `${identity.name} <${identity.email}>`
}

const FIX_HINT = [
  'Plain `git commit` — drop GIT_AUTHOR_*/GIT_COMMITTER_* overrides, --author and -c user.* —',
  'so the commit is authored and committed as Shogo Agent <agent@shogo.ai>; the commit-msg hook',
  'adds the co-author trailer.',
].join('\n  ')

function commitMsg(file: string): number {
  const author = currentIdent('AUTHOR')
  if (!isShogoIdentity(author)) return 0

  const raw = readFileSync(file, 'utf8')
  const commentChar = git(['config', '--get', 'core.commentChar']) || '#'
  const lines = raw.split('\n')
  const commentStart = lines.findIndex((line) => line.startsWith(commentChar))
  const contentEnd = commentStart === -1 ? lines.length : commentStart
  const content = lines.slice(0, contentEnd).join('\n')

  // An editor session that typed nothing must stay empty, or `git commit`
  // would happily commit a message consisting only of the trailer.
  if (content.trim() === '') return 0

  const { message, changed } = normalizeAgentAttribution(content)
  if (!changed) return 0

  const rest = commentStart === -1 ? '' : `\n${lines.slice(commentStart).join('\n')}`
  writeFileSync(file, `${message}${rest}`)
  notice(`[commit-msg] Folded the Shogo co-author into exactly one "${shogoCoAuthorTrailer()}".`)
  return 0
}

function verifyCommit(): number {
  const identity = agentCheckout()
  if (!identity) return 0

  for (const kind of ['AUTHOR', 'COMMITTER'] as const) {
    const actual = currentIdent(kind)
    if (isAgent(actual)) continue
    console.error(
      [
        `[pre-commit] Refusing to commit as ${describe(actual)} (${kind.toLowerCase()}).`,
        `This checkout commits as ${identity.name} <${identity.email}>.`,
        `  ${FIX_HINT}`,
      ].join('\n'),
    )
    return 1
  }
  return 0
}

function commitsBeingPushed(stdin: string): string[] {
  const shas = new Set<string>()
  for (const line of stdin.split('\n')) {
    const [, localOid, , remoteOid] = line.trim().split(/\s+/)
    if (!localOid || /^0+$/.test(localOid)) continue // branch deletion
    // Commits the remote does not have yet. Falling back to the whole history
    // only matters for the very first push of a repo with no remote at all.
    const range = remoteOid && !/^0+$/.test(remoteOid) ? [localOid, '--not', remoteOid] : [localOid, '--not', '--remotes']
    let list = git(['rev-list', ...range])
    if (list === null || (list === '' && (git(['remote']) ?? '') === '')) {
      list = git(['rev-list', localOid])
    }
    for (const sha of (list ?? '').split('\n')) if (sha.trim()) shas.add(sha.trim())
  }
  return [...shas]
}

function verifyPush(stdin: string): number {
  const identity = agentCheckout()
  if (!identity) return 0

  const offenders: string[] = []
  for (const sha of commitsBeingPushed(stdin)) {
    const fields = (git(['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', sha]) ?? '').split('\0')
    const author = { name: fields[0] ?? '', email: fields[1] ?? '' }
    const committer = { name: fields[2] ?? '', email: fields[3] ?? '' }
    if (isAgent(author) && isAgent(committer)) continue
    offenders.push(`  ${sha.slice(0, 9)}  ${describe(isAgent(author) ? committer : author)}`)
  }
  if (offenders.length === 0) return 0

  console.error(
    [
      `[pre-push] Refusing to push ${offenders.length} commit(s) not authored and committed by ${identity.name} <${identity.email}>:`,
      ...offenders,
      `  ${FIX_HINT}`,
    ].join('\n'),
  )
  return 1
}

function main(): number {
  const [mode, file] = process.argv.slice(2) as [Mode | undefined, string | undefined]
  const stdin = (): string => {
    try {
      return readFileSync(0, 'utf8')
    } catch {
      return ''
    }
  }

  if (mode === 'commit-msg') return file ? commitMsg(file) : 0
  if (mode === 'verify-commit') return verifyCommit()
  if (mode === 'verify-push') return verifyPush(stdin())
  console.error(`[git-attribution-hook] Unknown mode: ${mode ?? '(none)'}`)
  return 0
}

try {
  process.exit(main())
} catch (error) {
  // A broken hook must never block a commit or a push in someone else's
  // checkout; the attribution audit workflow reports what slipped through.
  console.error(`[git-attribution-hook] ${(error as Error).message}`)
  process.exit(0)
}
