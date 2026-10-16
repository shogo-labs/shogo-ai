// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared validation helpers for eval test cases.
 *
 * Centralised so every test-cases-*.ts file imports from one place
 * rather than re-declaring the same helpers.
 */

import type { EvalResult, ToolCallRecord } from './types'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Reads a file from the eval's live workspace directory (post-run), or ''
 * if the workspace is unavailable or the file doesn't exist.
 *
 * Grading criteria like `wroteSchema`/`schemaContainsModel` historically
 * only inspected this-phase tool-call diffs (`result.toolCalls`), which
 * made them blind to code that was already correct on disk — e.g. built by
 * an earlier pipeline phase, or present in a seeded fixture — that the
 * current phase correctly didn't need to rewrite. Use this as a fallback
 * so an efficient agent that reuses already-correct work isn't scored as
 * if that work doesn't exist.
 */
export function readWorkspaceFile(result: EvalResult, relPath: string): string {
  const dir = result.workspaceDir
  if (!dir) return ''
  try {
    return readFileSync(join(dir, relPath), 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Lists the repo-relative paths (e.g. `src/components/Foo.tsx`) of every
 * `.ts`/`.tsx`/`.js`/`.jsx` file under `src/` in the eval's live workspace
 * (skipping `src/generated`). Disk-state counterpart to `wroteCanvasFile`,
 * which only looks at this-phase `write_file` tool calls — see
 * `readWorkspaceFile` above for why that's insufficient on its own.
 */
export function listSrcFilePathsFromDisk(result: EvalResult): string[] {
  const dir = result.workspaceDir
  if (!dir) return []
  const srcDir = join(dir, 'src')
  if (!existsSync(srcDir)) return []
  const out: string[] = []
  const walk = (d: string, relPrefix: string, depth: number) => {
    if (depth > 10) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'generated' || name === 'node_modules') continue
      const full = join(d, name)
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full, rel, depth + 1)
        continue
      }
      if (/\.(tsx?|jsx?)$/.test(name)) {
        out.push(`src/${rel}`)
      }
    }
  }
  walk(srcDir, '', 0)
  return out
}

/** A canvas source file: `.ts(x)`/`.js(x)` under `src/` (or the legacy `canvas/` dir). */
export function isCanvasSourcePath(path: string): boolean {
  return /(^|\/)(src|canvas)\/.+\.(tsx?|jsx?)$/.test(path)
}

/** True if the agent wrote/edited a canvas source file via any route. */
export function wroteCanvasSource(result: EvalResult): boolean {
  return fileWrites(result).some(w => isCanvasSourcePath(w.path))
}

/**
 * Canvas v2 means writing React source under `src/`. Passes only if the
 * agent actually built canvas code that way AND never reached for a
 * retired v1 `canvas_*` tool, so it can't be earned by doing nothing.
 */
export function builtCanvasV2Only(result: EvalResult): boolean {
  return wroteCanvasSource(result) && !result.toolCalls.some(t => t.name.startsWith('canvas_'))
}

/**
 * Workspace-relative paths of every file in the eval's live workspace
 * (skipping node_modules, .git and src/generated). Use to check outcomes
 * like "reports exist" regardless of which tool — or which subagent —
 * wrote them.
 */
export function listWorkspaceFiles(result: EvalResult, maxDepth = 8): string[] {
  const dir = result.workspaceDir
  if (!dir || !existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || (rel === 'src' && name === 'generated')) continue
      const full = join(d, name)
      const relPath = rel ? `${rel}/${name}` : name
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(full, relPath, depth + 1)
      else out.push(relPath)
    }
  }
  walk(dir, '', 0)
  return out
}

/**
 * Concatenates the content of all `.ts`/`.tsx`/`.js`/`.jsx` files under
 * `src/` in the eval's live workspace (skipping `src/generated`). Disk-state
 * counterpart to the various per-file `allCanvasCode(r)` helpers, which only
 * look at this-phase `write_file`/`edit_file` tool calls — see
 * `readWorkspaceFile` above for why that's insufficient on its own.
 */
export function readAllSrcCodeFromDisk(result: EvalResult): string {
  const dir = result.workspaceDir
  if (!dir) return ''
  const srcDir = join(dir, 'src')
  if (!existsSync(srcDir)) return ''
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 10) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'generated' || name === 'node_modules') continue
      const full = join(d, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (/\.(tsx?|jsx?)$/.test(name)) {
        try {
          out.push(readFileSync(full, 'utf-8'))
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  walk(srcDir, 0)
  return out.join('\n')
}

/** True if `toolName` was called in any turn (history + final). */
export function usedTool(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName)
}

/** True if `toolName` was called in the final evaluated turn only. */
export function usedToolInFinalTurn(result: EvalResult, toolName: string): boolean {
  return result.finalTurnToolCalls.some(t => t.name === toolName)
}

/** True if `toolName` was NOT called in any turn (including via subagents). */
export function neverUsedTool(result: EvalResult, toolName: string): boolean {
  return !result.toolCalls.some(t => t.name === toolName)
}

/**
 * True if `toolName` was called anywhere — directly by the main agent OR
 * inside a subagent (flattened by runner.ts). Equivalent to usedTool() after
 * subagent tool call flattening, but semantically clearer for delegated tools.
 */
export function usedToolAnywhere(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName)
}

/** True if the agent delegated to a specific subagent type via agent_spawn. */
export function delegatedTo(result: EvalResult, subagentType: string): boolean {
  return result.toolCalls.some(t =>
    t.name === 'agent_spawn' &&
    typeof t.input === 'object' && t.input !== null &&
    (t.input as Record<string, unknown>).type === subagentType,
  )
}

/** True if `toolName` was NOT called in the final turn. */
export function didNotUseToolInFinalTurn(result: EvalResult, toolName: string): boolean {
  return !result.finalTurnToolCalls.some(t => t.name === toolName)
}

/**
 * Calls that collect a background task's result: `wait` on task ids, or the
 * legacy `agent_result` / `task_result` that older transcripts still use.
 */
/**
 * The result narrowed to this pipeline phase's own calls. Intention criteria
 * otherwise see every phase, which breaks ordering checks like "the second spawn".
 */
export function thisPhase(result: EvalResult): EvalResult {
  return result.phaseToolCalls ? { ...result, toolCalls: result.phaseToolCalls } : result
}

export function resultCollectionCalls(result: EvalResult): ToolCallRecord[] {
  return result.toolCalls.filter((t) => {
    if (t.name === 'agent_result' || t.name === 'task_result') return true
    if (t.name !== 'wait') return false
    const ids = (t.input as { task_ids?: unknown })?.task_ids
    return Array.isArray(ids) && ids.length > 0
  })
}

/** Count of calls to `toolName` across all turns. */
export function toolCallCount(result: EvalResult, toolName: string): number {
  return result.toolCalls.filter(t => t.name === toolName).length
}

/** True if the agent's response text contains every one of `terms` (case-insensitive). */
export function responseContains(result: EvalResult, ...terms: string[]): boolean {
  const text = result.responseText.toLowerCase()
  return terms.every(t => text.includes(t.toLowerCase()))
}

/**
 * Like `responseContains`, but searches every real turn's response text in
 * this eval (`allResponseText`), not just the final turn's (`responseText`).
 *
 * Use this for multi-turn evals whose `conversationHistory` asks for
 * genuinely distinct work in an earlier turn (e.g. "research trending
 * topics" in turn 2, then "build a demographics dashboard" in turn 4) —
 * `responseContains` would only ever see turn 4's text and could never
 * find content that was correctly produced and reported in turn 2.
 */
export function anyTurnResponseContains(result: EvalResult, ...terms: string[]): boolean {
  const text = (result.allResponseText || result.responseText).toLowerCase()
  return terms.every(t => text.includes(t.toLowerCase()))
}

/**
 * True if the agent set up a recurring reminder by any reasonable route:
 * heartbeat, a schedule, or a recurring calendar event (RRULE / recurrence).
 * One-off calendar events don't count.
 */
export function configuredRecurringReminder(result: EvalResult): boolean {
  if (usedToolAnywhere(result, 'heartbeat_configure') || usedToolAnywhere(result, 'schedule_create')) return true
  return result.toolCalls.some(t =>
    /CALENDAR.*(CREATE|INSERT|UPDATE).*EVENT|create_event|calendar_.*create/i.test(t.name) &&
    !t.error &&
    /rrule|recurrence|recurring/i.test(JSON.stringify(t.input)),
  )
}

/** JSON-stringified tool calls for ad-hoc substring searches. */
export function toolCallsJson(result: EvalResult): string {
  return JSON.stringify(result.toolCalls).toLowerCase()
}

/** True if any call to `toolName` has `value` anywhere in its JSON-serialised input. */
export function toolCallArgsContain(result: EvalResult, toolName: string, value: string): boolean {
  return result.toolCalls
    .filter(t => t.name === toolName)
    .some(t => JSON.stringify(t.input).toLowerCase().includes(value.toLowerCase()))
}

/** True if `toolName` was called and succeeded (not an error) at least once. */
export function usedToolSuccessfully(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName && !t.error)
}

/** Count of successful (non-error) calls to `toolName` across all turns. */
export function successfulToolCallCount(result: EvalResult, toolName: string): number {
  return result.toolCalls.filter(t => t.name === toolName && !t.error).length
}

/** True if any connect call was made without `command` or `args` (i.e. managed-style name-only install). */
export function installCalledWithoutCommand(result: EvalResult): boolean {
  return result.toolCalls
    .filter(t => t.name === 'connect')
    .some(t => {
      const input = t.input as Record<string, any>
      return !input.command && !input.args
    })
}

/** True if any `exec` tool call has a `command` input containing `substring` (case-insensitive). */
export function execCommandContains(result: EvalResult, substring: string): boolean {
  return result.toolCalls
    .filter(t => t.name === 'exec')
    .some(t => {
      const input = t.input as Record<string, any>
      return typeof input.command === 'string' &&
        input.command.toLowerCase().includes(substring.toLowerCase())
    })
}

/** True if the agent ran the GitHub CLI via exec (`gh …`). */
export function usedGhCli(result: EvalResult, subcommand?: string): boolean {
  return execCommandContains(result, subcommand ? `gh ${subcommand}` : 'gh ')
}

/**
 * True if any write route (`write_file`, `edit_file`, or an exec redirect /
 * heredoc / `tee`) targets `.env` and the written content contains `key`.
 */
export function wroteEnvFile(result: EvalResult, key: string): boolean {
  return fileWrites(result).some(w =>
    pathMatches(w.path, (p) => p === '.env' || p.endsWith('/.env')) && w.content.includes(key),
  )
}

// ---------------------------------------------------------------------------
// Route-agnostic file access (read / search / write)
//
// A competent engineer reads a file with `read_file` *or* `cat`, locates code
// with `search` *or* `rg`, and writes with `write_file` *or* a heredoc. Grade
// the outcome, not the tool name — except in evals that deliberately test
// tool choice (e.g. discipline-use-read-not-cat).
// ---------------------------------------------------------------------------

/** A path matcher: exact/suffix string, RegExp, or predicate on the normalised path. */
export type PathMatcher = string | RegExp | ((path: string) => boolean)

function normalisePath(p: string): string {
  return p.trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * True if `path` matches `matcher`. String matchers match the exact path,
 * any path ending in `/<matcher>`, or a relative path that is a suffix of the
 * matcher (the agent may have `cd`'d into a subdirectory first).
 */
export function pathMatches(path: string, matcher: PathMatcher): boolean {
  const p = normalisePath(path)
  if (!p) return false
  if (typeof matcher === 'function') return matcher(p)
  if (matcher instanceof RegExp) return matcher.test(p)
  const m = normalisePath(matcher)
  return p === m || p.endsWith(`/${m}`) || (!p.startsWith('/') && m.endsWith(`/${p}`))
}

/** Every shell command the agent ran via `exec` / `terminal_exec`, in order. */
export function execCommands(result: EvalResult, calls: ToolCallRecord[] = result.toolCalls): string[] {
  return calls
    .filter(t => t.name === 'exec' || t.name === 'terminal_exec')
    .map(t => (t.input as Record<string, unknown>)?.command)
    .filter((c): c is string => typeof c === 'string')
}

/**
 * Removes heredoc bodies from a command so their content isn't mistaken for
 * commands. Returns the stripped command plus each heredoc body keyed by the
 * line index that opened it.
 */
function stripHeredocs(command: string): { lines: string[]; bodies: Map<number, string> } {
  const src = command.split('\n')
  const lines: string[] = []
  const bodies = new Map<number, string>()
  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/)
    lines.push(line)
    if (!m) continue
    const delim = m[2]
    const body: string[] = []
    let j = i + 1
    while (j < src.length && src[j].trim() !== delim) body.push(src[j++])
    bodies.set(lines.length - 1, body.join('\n'))
    i = j
  }
  return { lines, bodies }
}

/**
 * Splits a compound shell command into simple commands on `;`, `&&`, `||`,
 * `|` and newlines (heredoc bodies are dropped). Quoting is not parsed — this
 * is a grading heuristic, not a shell.
 */
export function splitShellCommand(command: string): string[] {
  const { lines } = stripHeredocs(command)
  return lines
    .flatMap(l => l.split(/&&|\|\||[;|]/))
    .map(s => s.trim())
    .filter(Boolean)
}

/** Tokenises a simple command, dropping `sudo`, `env`, and leading `VAR=value` assignments. */
function commandTokens(segment: string): string[] {
  const tokens = segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  let i = 0
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env' || /^[A-Za-z_]\w*=/.test(tokens[i]))) i++
  return tokens.slice(i).map(t => t.replace(/^['"]|['"]$/g, ''))
}

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl'])

/** Paths an exec command reads (cat/head/tail/less/more/bat/nl/`sed -n`). */
export function execReadPaths(command: string): string[] {
  const out: string[] = []
  for (const seg of splitShellCommand(command)) {
    const [cmd, ...rest] = commandTokens(seg)
    if (!cmd) continue
    const base = cmd.split('/').pop()!
    const isSedPrint = base === 'sed' && rest.some(a => /^-[a-z]*n/.test(a)) && !rest.some(a => /^-[a-z]*i/.test(a))
    if (!READ_COMMANDS.has(base) && !isSedPrint) continue
    // `cat > file` / `cat >> file` is a write, not a read.
    if (base === 'cat' && /(^|\s)>>?/.test(seg)) continue
    let skipNext = false
    for (const arg of rest) {
      if (skipNext) { skipNext = false; continue }
      if (/^-[nc]$/.test(arg) && (base === 'head' || base === 'tail')) { skipNext = true; continue }
      if (arg.startsWith('-') || arg.startsWith('>') || arg.startsWith('<') || arg.startsWith('&')) continue
      if (isSedPrint && /^\d|^\/|^\$|p$/.test(arg) && !arg.includes('.')) continue
      out.push(normalisePath(arg))
    }
  }
  return out
}

/** Every path the agent read via `read_file` or an exec read command. */
export function readPaths(result: EvalResult, calls: ToolCallRecord[] = result.toolCalls): string[] {
  const out: string[] = []
  for (const t of calls) {
    if (t.name === 'read_file') {
      const p = (t.input as Record<string, unknown>)?.path
      if (typeof p === 'string') out.push(normalisePath(p))
    }
  }
  for (const cmd of execCommands(result, calls)) out.push(...execReadPaths(cmd))
  return out
}

/**
 * True if the agent read a file matching `matcher` via `read_file` OR exec
 * (`cat`/`head`/`tail`/`sed -n`/`less`/`bat`). With no matcher, true if the
 * agent read any file at all.
 */
export function readFileAnyRoute(result: EvalResult, matcher?: PathMatcher, calls?: ToolCallRecord[]): boolean {
  const paths = readPaths(result, calls)
  return matcher === undefined ? paths.length > 0 : paths.some(p => pathMatches(p, matcher))
}

const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'find', 'fd', 'ls', 'tree'])

/** True if `command` contains a search/explore step (rg/grep/find/ls/tree/git grep/…). */
export function execIsSearch(command: string): boolean {
  return splitShellCommand(command).some(seg => {
    const [cmd, sub] = commandTokens(seg)
    if (!cmd) return false
    const base = cmd.split('/').pop()!
    return SEARCH_COMMANDS.has(base) || (base === 'git' && (sub === 'grep' || sub === 'ls-files'))
  })
}

/** True if `command` contains a code search step (rg/grep/ag/ack/git grep) — not just listing. */
export function execIsGrep(command: string): boolean {
  return splitShellCommand(command).some(seg => {
    const [cmd, sub] = commandTokens(seg)
    if (!cmd) return false
    const base = cmd.split('/').pop()!
    return ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack'].includes(base) || (base === 'git' && sub === 'grep')
  })
}

/** Calls that searched or explored the codebase: `search`, `read_file`, or an exec search command. */
export function searchCalls(result: EvalResult, calls: ToolCallRecord[] = result.toolCalls): ToolCallRecord[] {
  return calls.filter(t => {
    if (t.name === 'search' || t.name === 'read_file') return true
    if (t.name !== 'exec' && t.name !== 'terminal_exec') return false
    const cmd = (t.input as Record<string, unknown>)?.command
    return typeof cmd === 'string' && (execIsSearch(cmd) || execReadPaths(cmd).length > 0)
  })
}

/** True if the agent searched/explored the codebase via any route. */
export function searchedAnyRoute(result: EvalResult, calls?: ToolCallRecord[]): boolean {
  return searchCalls(result, calls).length > 0
}

export interface FileWrite {
  path: string
  /** Full content for whole-file writes, `new_string` for edits, heredoc/echo text for exec. */
  content: string
  via: 'write_file' | 'edit_file' | 'exec'
}

/** Files an exec command writes via redirection (`>`/`>>`, heredocs) or `tee`. */
export function execFileWrites(command: string): Array<{ path: string; content: string }> {
  const { lines, bodies } = stripHeredocs(command)
  const out: Array<{ path: string; content: string }> = []
  lines.forEach((line, idx) => {
    const body = bodies.get(idx)
    for (const seg of line.split(/&&|\|\||[;|]/)) {
      const targets: string[] = []
      const redirect = /(?:^|[^0-9&<>])>>?\s*(['"]?)([^\s'";&|<>]+)\1/g
      let m: RegExpExecArray | null
      while ((m = redirect.exec(seg))) targets.push(m[2])
      const tee = seg.match(/(?:^|\s)tee\s+((?:-\w+\s+)*)(['"]?)([^\s'";&|<>]+)\2/)
      if (tee) targets.push(tee[3])
      for (const raw of targets) {
        const path = normalisePath(raw)
        if (!path || path.startsWith('&') || path === '/dev/null' || path.startsWith('/dev/')) continue
        out.push({ path, content: body ?? seg })
      }
    }
  })
  return out
}

/** Every file write the agent made via `write_file`, `edit_file`, or exec. */
export function fileWrites(result: EvalResult, calls: ToolCallRecord[] = result.toolCalls): FileWrite[] {
  const out: FileWrite[] = []
  for (const t of calls) {
    const input = (t.input ?? {}) as Record<string, unknown>
    const path = typeof input.path === 'string' ? input.path : ''
    if (t.name === 'write_file' && path) {
      out.push({ path: normalisePath(path), content: String(input.content ?? ''), via: 'write_file' })
    } else if (t.name === 'edit_file' && path) {
      const content = typeof input.new_string === 'string' ? input.new_string
        : typeof input.newString === 'string' ? input.newString
        : JSON.stringify(input.edits ?? input)
      out.push({ path: normalisePath(path), content, via: 'edit_file' })
    } else if ((t.name === 'exec' || t.name === 'terminal_exec') && typeof input.command === 'string') {
      for (const w of execFileWrites(input.command)) out.push({ ...w, via: 'exec' })
    }
  }
  return out
}

/** True if the agent wrote a file matching `matcher` via any route (optionally containing `contains`). */
export function wroteFileAnyRoute(result: EvalResult, matcher: PathMatcher, contains?: string | RegExp, calls?: ToolCallRecord[]): boolean {
  return fileWrites(result, calls).some(w => {
    if (!pathMatches(w.path, matcher)) return false
    if (contains === undefined) return true
    return typeof contains === 'string' ? w.content.includes(contains) : contains.test(w.content)
  })
}

/** Concatenated content the agent wrote to files matching `matcher`, via any route. */
export function writtenContent(result: EvalResult, matcher: PathMatcher, calls?: ToolCallRecord[]): string {
  return fileWrites(result, calls).filter(w => pathMatches(w.path, matcher)).map(w => w.content).join('\n')
}

/**
 * True if `secret` appears in an exec command other than a write of it into
 * `.env` (e.g. `GITHUB_TOKEN=… gh …`, `curl -H "Authorization: Bearer …"`).
 * `echo KEY=… >> .env` / `cat >> .env <<EOF` save the secret where it
 * belongs and don't count as inlining.
 */
export function execInlinesSecret(result: EvalResult, secret: string): boolean {
  const isEnv = (p: string) => p === '.env' || p.endsWith('/.env')
  return execCommands(result).some(cmd => {
    if (!cmd.includes(secret)) return false
    const { lines } = stripHeredocs(cmd)
    // Per pipeline, so `echo K=… >> .env && curl -H "…"` still counts as inlining.
    return lines.some(line => line.split(/&&|\|\||;/).some(seg =>
      seg.includes(secret) && !execFileWrites(seg).some(w => isEnv(w.path)),
    ))
  })
}

/** True if the agent deleted a file matching `matcher` via `delete_file` or exec `rm`. */
export function deletedFileAnyRoute(result: EvalResult, matcher: PathMatcher): boolean {
  for (const t of result.toolCalls) {
    if (t.name !== 'delete_file') continue
    const p = (t.input as Record<string, unknown>)?.path
    if (typeof p === 'string' && pathMatches(p, matcher)) return true
  }
  return execCommands(result).some(cmd =>
    splitShellCommand(cmd).some(seg => {
      const [c, ...args] = commandTokens(seg)
      if (c !== 'rm' && c !== 'trash') return false
      return args.filter(a => !a.startsWith('-')).some(a => {
        if (pathMatches(a, matcher)) return true
        // `rm -rf dir` deletes everything under dir.
        const dir = normalisePath(a)
        return typeof matcher === 'string' && (normalisePath(matcher).startsWith(`${dir}/`) || normalisePath(matcher).includes(`/${dir}/`))
      })
    }),
  )
}

// ---------------------------------------------------------------------------
// Gateway quality signals (loop / iteration ceiling / empty response)
// ---------------------------------------------------------------------------

/**
 * True if the agent's turn ended in a detected loop. Reads the gateway signal
 * captured from the `data-usage` frame, with a fallback to the `[LOOP DETECTED]`
 * marker the agent loop injects into the final text.
 */
export function hitLoop(result: EvalResult): boolean {
  return result.loopDetected === true || result.responseText.includes('[LOOP DETECTED]')
}

/** True if the agent hit the per-turn iteration ceiling (maxIterationsExhausted). */
export function hitMaxTurns(result: EvalResult): boolean {
  return result.hitMaxTurns === true
}

/**
 * True if the final assistant message was empty/blank. Prefers the gateway
 * signal but falls back to a trimmed-text check for robustness.
 */
export function responseWasEmpty(result: EvalResult): boolean {
  if (result.responseEmpty === true) return true
  return result.responseText.trim().length === 0
}

// ---------------------------------------------------------------------------
// Skill server exec validation
// ---------------------------------------------------------------------------

interface ExecCallInfo {
  command: string
  stdout: string
  exitCode: number
}

/** Extract all exec tool calls that target the local skill server. */
export function execCallsToSkillServer(result: EvalResult): ExecCallInfo[] {
  return result.toolCalls
    .filter(t => t.name === 'exec')
    .map(t => {
      const output = t.output as any
      const input = t.input as any
      const command = typeof input?.command === 'string' ? input.command : ''
      const stdout = output?.details?.stdout ?? output?.stdout ?? ''
      const exitCode = output?.details?.exitCode ?? output?.exitCode ?? 1
      return { command, stdout: String(stdout), exitCode: Number(exitCode) }
    })
    .filter(o =>
      o.command.includes('localhost:4100') ||
      o.command.includes('127.0.0.1:4100') ||
      o.stdout.includes('localhost:4100') ||
      o.stdout.includes('127.0.0.1:4100')
    )
}

/** True if the agent made at least one exec call to the skill server that returned valid data. */
export function anyExecToSkillServerSucceeded(result: EvalResult): boolean {
  const calls = execCallsToSkillServer(result)
  if (calls.length === 0) return true
  return calls.some(c =>
    c.exitCode === 0 &&
    !c.stdout.includes('ENOENT') &&
    !c.stdout.includes('404 Not Found') &&
    !c.stdout.includes('Cannot connect')
  )
}

/** True if the agent's last exec call to the skill server did not return an error. */
export function lastSkillServerExecSucceeded(result: EvalResult): boolean {
  const calls = execCallsToSkillServer(result)
  if (calls.length === 0) return true
  const last = calls[calls.length - 1]
  return last.exitCode === 0 &&
    !last.stdout.includes('ENOENT') &&
    !last.stdout.includes('404 Not Found') &&
    !last.stdout.includes('Cannot connect')
}

// ---------------------------------------------------------------------------
// Plan tool validation
// ---------------------------------------------------------------------------

/** True if any create_plan or update_plan call has `value` in the given `field` (case-insensitive). */
export function planToolArgsContain(result: EvalResult, field: string, value: string): boolean {
  return result.toolCalls
    .filter(t => t.name === 'create_plan' || t.name === 'update_plan')
    .some(t => {
      const input = t.input as Record<string, any>
      const fieldVal = input[field]
      if (typeof fieldVal === 'string') {
        return fieldVal.toLowerCase().includes(value.toLowerCase())
      }
      if (Array.isArray(fieldVal)) {
        return JSON.stringify(fieldVal).toLowerCase().includes(value.toLowerCase())
      }
      return false
    })
}

/** Returns the number of todos in the first create_plan or update_plan call. */
export function planTodoCount(result: EvalResult): number {
  const planCall = result.toolCalls.find(t => t.name === 'create_plan' || t.name === 'update_plan')
  if (!planCall) return 0
  const input = planCall.input as Record<string, any>
  return Array.isArray(input.todos) ? input.todos.length : 0
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * True if the last schema write in this eval still contains `modelName`.
 * Returns true when no schema was written (prior models are untouched on disk).
 */
export function lastSchemaPreservesModel(result: EvalResult, modelName: string): boolean {
  const schemaWrites = result.toolCalls
    .filter(t => t.name === 'write_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (schemaWrites.length === 0) return true
  const last = schemaWrites[schemaWrites.length - 1]
  const content = String((last.input as any).content ?? '')
  return content.includes(`model ${modelName}`)
}
