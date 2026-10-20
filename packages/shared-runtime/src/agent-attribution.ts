// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export const DEFAULT_SHOGO_AGENT_NAME = 'Shogo Agent'
export const DEFAULT_SHOGO_AGENT_EMAIL = 'agent@shogo.ai'
export const SHOGO_PR_FOOTER_MARKER = '<!-- made-with-shogo -->'
export const CO_AUTHOR_TRAILER_KEY = 'Co-authored-by'

/**
 * Every identity Shogo has ever committed or co-authored with resolves to a
 * `@shogo.ai` / `@shogo.local` address — `agent@shogo.ai` (canonical),
 * `noreply@shogo.ai`, `dev1@shogo.ai`, `dev2@shogo.local`, `qa@shogo.local`.
 * Anything else in a `Co-authored-by:` line belongs to a human or another tool
 * and is left alone.
 */
const SHOGO_AGENT_EMAIL_RE = /^[^@\s<>]+@shogo\.(?:ai|local)$/i

/** `Shogo`, `Shogo Agent`, `Shogo Dev 2`, `Shogo QA`, `Shogo CI`, `Shogo Bot`… */
const SHOGO_AGENT_NAME_RE = /^shogo(?:\s+(?:agent|dev\s*\d+|qa|planner|reflection|ci|bot|cloud|worker|team))?$/i

export interface AgentIdentity {
  name: string
  email: string
}

export function isShogoAgentEmail(email: string | null | undefined): boolean {
  return SHOGO_AGENT_EMAIL_RE.test((email ?? '').trim())
}

export function isShogoAgentIdentity(
  name: string | null | undefined,
  email: string | null | undefined,
): boolean {
  if (isShogoAgentEmail(email)) return true
  return SHOGO_AGENT_NAME_RE.test((name ?? '').trim())
}

/**
 * True only for the one identity an agent checkout commits as. Attribution
 * *repair* accepts any Shogo identity (they all belong to us); the commit and
 * push guards accept nothing but the canonical one, which is what
 * `agent@shogo.ai` resolves to on GitHub (user ShogoAgent, CLA-signed).
 */
export function isCanonicalShogoAgentIdentity(
  name: string | null | undefined,
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (name ?? '').trim() === getShogoAgentName(env) &&
    (email ?? '').trim().toLowerCase() === getShogoAgentEmail(env).toLowerCase()
  )
}

/**
 * The identity a Shogo-provisioned checkout commits as, when the checkout's
 * configured `user.email` is an agent address. `null` means a human (or an
 * unrelated tool) owns the checkout and must be left alone.
 */
export function agentIdentityFromConfig(
  email: string | null | undefined,
): AgentIdentity | null {
  return isShogoAgentEmail(email)
    ? { name: DEFAULT_SHOGO_AGENT_NAME, email: DEFAULT_SHOGO_AGENT_EMAIL }
    : null
}

export function getShogoAgentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHOGO_AGENT_GIT_NAME || DEFAULT_SHOGO_AGENT_NAME
}

export function getShogoAgentEmail(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.SHOGO_AGENT_GIT_EMAIL ?? '').trim()
  return isShogoAgentEmail(configured) ? configured : DEFAULT_SHOGO_AGENT_EMAIL
}

export function shogoCoAuthorTrailer(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `Co-authored-by: ${getShogoAgentName(env)} <${getShogoAgentEmail(env)}>`
}

/**
 * Add GitHub's standard co-author trailer to a git commit argument list.
 * The returned array is safe to pass to execFile/spawn because it does not
 * involve shell quoting.
 *
 * Message values (`-m` / `--message`) are normalized first, so a hand-written
 * or caller-supplied `Co-authored-by:` naming a Shogo identity is folded into
 * the canonical one instead of being joined by a second, gray-avatar line.
 * This is the code path for every commit that bypasses the hooks
 * (`--no-verify`), so attribution never depends on the hook running.
 */
export function withShogoCommitTrailer(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (args[0] !== 'commit') return [...args]

  const trailer = shogoCoAuthorTrailer(env)
  const result = [...args]
  for (let index = 1; index < result.length; index += 1) {
    const arg = result[index]
    if (arg === '--') break
    // Callers hand us arrays built from optional values (`commit -m <message>`
    // with an undefined message is reachable through the API's legacy positional
    // signature), so an element can be missing even though the type says string.
    if (typeof arg !== 'string') continue
    if ((arg === '-m' || arg === '--message') && typeof result[index + 1] === 'string') {
      result[index + 1] = normalizeAgentAttribution(result[index + 1]!, env, { appendWhenMissing: false }).message
      index += 1
      continue
    }
    if (arg.startsWith('--message=')) {
      result[index] = `--message=${normalizeAgentAttribution(arg.slice('--message='.length), env, { appendWhenMissing: false }).message}`
    }
  }

  for (let index = 0; index < result.length; index += 1) {
    if (result[index] === '--trailer' && result[index + 1] === trailer) {
      return result
    }
  }
  return [...result, '--trailer', trailer]
}

interface ParsedTrailer {
  key: string
  value: string
  lines: string[]
}

const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/
const TRAILER_IDENTITY_RE = /^(.*?)\s*<([^>]+)>$/

function parseTrailerBlock(block: readonly string[]): ParsedTrailer[] | null {
  const trailers: ParsedTrailer[] = []
  for (const line of block) {
    const match = TRAILER_LINE_RE.exec(line)
    if (match) {
      trailers.push({ key: match[1]!, value: match[2]!, lines: [line] })
      continue
    }
    if (/^[ \t]/.test(line) && trailers.length > 0) {
      const last = trailers[trailers.length - 1]!
      last.value = `${last.value}\n${line.trim()}`
      last.lines.push(line)
      continue
    }
    return null
  }
  return trailers.length > 0 ? trailers : null
}

function isShogoCoAuthorValue(value: string): boolean {
  const identity = TRAILER_IDENTITY_RE.exec(value.trim())
  if (!identity) return isShogoAgentIdentity(value, '')
  return isShogoAgentIdentity(identity[1], identity[2])
}

export interface NormalizeAttributionOptions {
  /**
   * Append the canonical trailer when the message has none. `false` only
   * repairs what is already written — used when git's `--trailer` supplies
   * the missing line (see {@link withShogoCommitTrailer}).
   */
  appendWhenMissing?: boolean
}

/**
 * Fold every Shogo-generated co-author in a commit message into exactly one
 * canonical `Co-authored-by: <agent identity>` placed last in the trailer
 * block, appending it when the message has none. Co-authors that are not a
 * Shogo identity (humans, other tools) and the rest of the message are left
 * byte-for-byte untouched. Pure, and idempotent.
 */
export function normalizeAgentAttribution(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  options: NormalizeAttributionOptions = {},
): { message: string; changed: boolean } {
  const canonical = shogoCoAuthorTrailer(env)
  const canonicalValue = canonical.slice(canonical.indexOf(':') + 1).trim()
  const trailingNewlines = /\n*$/.exec(message)?.[0] ?? ''
  const body = message.slice(0, message.length - trailingNewlines.length)
  if (body.trim() === '') return { message, changed: false }

  const lines = body.split('\n')
  let blockStart = lines.length
  while (blockStart > 0 && lines[blockStart - 1]!.trim() !== '') blockStart -= 1
  const trailers = parseTrailerBlock(lines.slice(blockStart))

  let rebuilt: string
  if (!trailers) {
    if (options.appendWhenMissing === false) return { message, changed: false }
    rebuilt = `${body}\n\n${canonical}`
  } else {
    const kept = trailers.filter(
      (trailer) =>
        !(
          trailer.key.toLowerCase() === CO_AUTHOR_TRAILER_KEY.toLowerCase() &&
          isShogoCoAuthorValue(trailer.value)
        ),
    )
    const alreadyCanonical = kept.some(
      (trailer) =>
        trailer.key.toLowerCase() === CO_AUTHOR_TRAILER_KEY.toLowerCase() &&
        trailer.value.trim() === canonicalValue,
    )
    const trailerLines = kept.flatMap((trailer) => trailer.lines)
    if (!alreadyCanonical && options.appendWhenMissing !== false) trailerLines.push(canonical)
    const head = blockStart === 0 ? [] : lines.slice(0, blockStart)
    rebuilt = trailerLines.length === 0
      ? head.join('\n').replace(/\n+$/, '')
      : [...head, ...trailerLines].join('\n')
  }

  const normalized = rebuilt + trailingNewlines
  return { message: normalized, changed: normalized !== message }
}

export interface AttributionReport {
  /** Canonical `Co-authored-by: <agent identity>` lines (a squash folds one per branch commit). */
  canonical: number
  /** Co-author values that name a Shogo identity but are not the canonical one. */
  nonCanonical: string[]
}

/**
 * What a commit message actually says about Shogo's co-authorship. Used by the
 * report-only attribution audit: a non-canonical Shogo co-author is the
 * gray-avatar class, while repeated canonical lines are just a squash merge
 * folding each branch commit's trailer.
 */
export function inspectAgentAttribution(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): AttributionReport {
  const canonicalTrailer = shogoCoAuthorTrailer(env)
  const canonicalValue = canonicalTrailer.slice(canonicalTrailer.indexOf(':') + 1).trim()
  const trailingNewlines = /\n*$/.exec(message)?.[0] ?? ''
  const body = message.slice(0, message.length - trailingNewlines.length)
  const lines = body.split('\n')
  let blockStart = lines.length
  while (blockStart > 0 && lines[blockStart - 1]!.trim() !== '') blockStart -= 1
  const trailers = parseTrailerBlock(lines.slice(blockStart)) ?? []

  let canonical = 0
  const nonCanonical: string[] = []
  for (const trailer of trailers) {
    if (trailer.key.toLowerCase() !== CO_AUTHOR_TRAILER_KEY.toLowerCase()) continue
    if (!isShogoCoAuthorValue(trailer.value)) continue
    if (trailer.value.trim() === canonicalValue) canonical += 1
    else nonCanonical.push(`${trailer.key}: ${trailer.value}`)
  }
  return { canonical, nonCanonical }
}

export function shogoPrFooter(): string {
  return `${SHOGO_PR_FOOTER_MARKER}\nMade with [Shogo](https://shogo.ai)`
}

export function withShogoPrFooter(body: string | null | undefined): string {
  const normalized = body?.trimEnd() ?? ''
  if (normalized.includes(SHOGO_PR_FOOTER_MARKER)) return normalized
  return normalized ? `${normalized}\n\n---\n${shogoPrFooter()}` : shogoPrFooter()
}
