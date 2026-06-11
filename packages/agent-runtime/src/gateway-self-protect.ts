// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gateway self-protection for the `exec` tool.
 *
 * The agent's `exec` runs shell commands in the same process namespace as the
 * agent-runtime gateway. A broad process kill therefore reaches the gateway
 * itself: observed in the wild (mimo, codegen-safety eval) running
 * `pkill -f <pattern>` whose pattern matched the gateway's own command line.
 * The gateway caught SIGTERM, ran its graceful shutdown, and the whole VM /
 * preview went down mid-task — taking the run with it.
 *
 * This guard rejects *only* the commands that would actually signal the gateway
 * process, with a message steering the agent toward a narrower target. It is
 * deliberately precise (it mirrors how `pkill`/`kill`/`killall` select targets)
 * so the agent can still kill its own dev servers, stuck ports, etc.:
 *   - `pkill -f <pat>`   → blocked iff <pat> (as a regex) matches the gateway
 *                          command line.
 *   - `pkill <pat>` / `killall <name>` → blocked iff it matches the gateway
 *                          process name (the runtime, e.g. `bun`/`node`).
 *   - `kill [-SIG] <pid>` → blocked iff a target is the gateway pid/ppid, or a
 *                          "everything" target (`-1`).
 */

import { basename } from 'node:path'

export interface GatewayIdentity {
  /** The gateway process pid (and its parent — killing either takes us down). */
  pid: number
  ppid: number
  /** Names `pkill <name>` / `killall <name>` match against (runtime + entry). */
  nameTokens: string[]
  /** Full command line `pkill -f <pat>` matches against. */
  cmdline: string
}

/** Snapshot the current process as the gateway to protect. */
export function getGatewayIdentity(): GatewayIdentity {
  const runtime = basename(process.execPath || 'node') // e.g. "bun" / "node"
  const entry = process.argv[1] ? basename(process.argv[1]) : '' // e.g. "server.js"
  const title = typeof process.title === 'string' ? process.title : ''
  const nameTokens = uniq(
    [runtime, runtime.slice(0, 15) /* Linux comm is truncated to 15 */, entry, title]
      .map((t) => t.trim())
      .filter(Boolean),
  )
  const cmdline = [process.execPath, ...process.argv.slice(1)].join(' ').trim()
  return { pid: process.pid, ppid: typeof process.ppid === 'number' ? process.ppid : -1, nameTokens, cmdline }
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs))
}

/** Split a shell line into segments on separators that start a new command. */
function splitSegments(command: string): string[] {
  // Good enough for argv-level inspection: break on ; | & newlines and the
  // && / || compounds. We only need the leading program + its args per segment.
  return command
    .split(/(?:\|\||&&|[;\n|&])/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Tokenize a single segment into bare words, stripping simple quoting. */
function tokenize(segment: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

/** Strip a leading path so `/usr/bin/pkill` reads as `pkill`. */
function program(token: string): string {
  return basename(token || '')
}

function regexMatches(pattern: string, haystack: string): boolean {
  try {
    return new RegExp(pattern).test(haystack)
  } catch {
    // Not a valid regex — pkill would treat it literally.
    return haystack.includes(pattern)
  }
}

/** Non-flag tokens after the program name (e.g. the pattern / pid list). */
function operands(tokens: string[]): string[] {
  return tokens.slice(1).filter((t) => t !== '--' && !t.startsWith('-'))
}

export interface GuardResult {
  blocked: boolean
  reason?: string
}

/**
 * True when running `command` would deliver a signal to the gateway process.
 * Inspects each `;`/`|`/`&&`-separated segment for a `kill`/`pkill`/`killall`
 * (or `killall5`) invocation that selects the gateway.
 */
export function commandTargetsGateway(
  command: string,
  identity: GatewayIdentity = getGatewayIdentity(),
): GuardResult {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) continue
    const prog = program(tokens[0])

    if (prog === 'pkill') {
      const usesFullCmdline = tokens.includes('-f') || tokens.some((t) => /^-\w*f/.test(t))
      const ops = operands(tokens)
      for (const pat of ops) {
        if (usesFullCmdline) {
          if (regexMatches(pat, identity.cmdline)) {
            return { blocked: true, reason: `\`pkill -f ${pat}\` matches the Shogo runtime's command line` }
          }
        } else if (identity.nameTokens.some((n) => regexMatches(pat, n))) {
          return { blocked: true, reason: `\`pkill ${pat}\` matches the Shogo runtime process (${identity.nameTokens.join(', ')})` }
        }
      }
    } else if (prog === 'killall' || prog === 'killall5') {
      if (prog === 'killall5') {
        return { blocked: true, reason: '`killall5` signals every process, including the Shogo runtime' }
      }
      const ops = operands(tokens)
      for (const name of ops) {
        if (identity.nameTokens.some((n) => n === name || program(name) === n)) {
          return { blocked: true, reason: `\`killall ${name}\` would terminate the Shogo runtime process` }
        }
      }
    } else if (prog === 'kill') {
      for (const op of operands(tokens)) {
        const pid = Number(op)
        if (!Number.isFinite(pid)) continue
        if (pid === identity.pid || pid === identity.ppid) {
          return { blocked: true, reason: `\`kill ${op}\` targets the Shogo runtime process (pid ${identity.pid})` }
        }
      }
      // `kill -- -1` / `kill -1` style "signal everything" forms.
      if (tokens.slice(1).some((t) => t === '-1') && tokens.includes('--')) {
        return { blocked: true, reason: '`kill -- -1` signals every process, including the Shogo runtime' }
      }
    }
  }
  return { blocked: false }
}

/** Human-facing error returned to the agent when a kill would hit the gateway. */
export function gatewayKillRefusal(reason: string): string {
  return (
    `Refused: this command would terminate the Shogo runtime that hosts your tools (${reason}). ` +
    `The gateway runs in the same environment as your shell, so a broad process kill takes down the whole session. ` +
    `Target the specific process instead — e.g. find it with \`lsof -ti:<port>\` or \`pgrep -f <your-app>\` and \`kill <that-pid>\`.`
  )
}
