// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Read-only `exec` for restricted modes (plan, coordinator): the agent keeps
 * the terminal for code search and git archaeology, but only for a small set
 * of commands that cannot write to the workspace or run other programs.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'

export type ReadOnlyCheck = { ok: true; command: string } | { ok: false; reason: string }

export const READ_ONLY_COMMANDS = ['rg', 'git', 'ls', 'wc', 'head', 'tail', 'cat', 'find'] as const

const GIT_SUBCOMMANDS = new Set(['log', 'show', 'blame', 'grep', 'diff', 'status', 'ls-files', 'rev-parse'])
/** Subcommands that render diffs, where textconv drivers and external diff tools would otherwise run. */
const GIT_DIFF_SUBCOMMANDS = new Set(['log', 'show', 'diff', 'blame'])
/** Repo config can name programs git runs on read paths (fsmonitor, pager, external diff); neutralise them. */
const GIT_PREFIX = ['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=']

const FIND_FORBIDDEN = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'])

/** Characters that only have shell meaning outside quotes; rejecting them rules out pipes, chaining and redirection. */
const SHELL_METACHARS = new Set(['|', ';', '&', '>', '<', '`', '$', '(', ')', '\n', '\r'])
/** Unquoted words made only of these are passed through untouched so globs like `src/*.ts` still expand. */
const BARE_WORD = /^[\w./*?@%+=:,~^{}[\]-]+$/

interface Token {
  value: string
  quoted: boolean
}

function tokenize(command: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = []
  let current = ''
  let quoted = false
  let inToken = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return { error: 'unterminated single quote' }
      current += command.slice(i + 1, end)
      quoted = inToken = true
      i = end
    } else if (ch === '"') {
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        const c = command[j]
        if (c === '$' || c === '`') return { error: 'use single quotes for patterns containing $ or `' }
        if (c === '\\' && j + 1 < command.length && '"\\'.includes(command[j + 1])) j++
        current += command[j]
      }
      if (j >= command.length) return { error: 'unterminated double quote' }
      quoted = inToken = true
      i = j
    } else if (ch === '\\') {
      if (i + 1 >= command.length) return { error: 'trailing backslash' }
      current += command[++i]
      quoted = inToken = true
    } else if (ch === ' ' || ch === '\t') {
      if (inToken) tokens.push({ value: current, quoted })
      current = ''
      quoted = inToken = false
    } else if (SHELL_METACHARS.has(ch)) {
      return { error: `\`${ch === '\n' ? '\\n' : ch}\` is not allowed: run one command at a time, with no pipes, redirects or substitutions` }
    } else {
      current += ch
      inToken = true
    }
  }
  if (inToken) tokens.push({ value: current, quoted })
  return { tokens }
}

function quote(token: Token): string {
  if (!token.quoted && BARE_WORD.test(token.value)) return token.value
  return `'${token.value.replace(/'/g, `'\\''`)}'`
}

const isShortFlagCluster = (arg: string) => /^-[A-Za-z]+$/.test(arg)

function checkRg(args: string[]): string | null {
  for (const arg of args) {
    if (arg === '--pre' || arg.startsWith('--pre=') || arg.startsWith('--pre-glob')) return '`rg --pre` runs a program on every file'
    if (arg === '--search-zip' || (isShortFlagCluster(arg) && arg.includes('z'))) return '`rg -z` runs decompression programs'
  }
  return null
}

function checkGit(args: string[]): string | null {
  const sub = args[0]
  if (!sub || !GIT_SUBCOMMANDS.has(sub)) {
    return `only these git subcommands are allowed: ${[...GIT_SUBCOMMANDS].join(', ')} (global options such as -C or -c are not)`
  }
  for (const arg of args.slice(1)) {
    if (arg === '-c') return `\`git ${sub} -c\` is not allowed`
    if (sub === 'grep' && (arg.startsWith('-O') || arg.startsWith('--open-files-in-pager'))) return '`git grep -O` opens a pager program'
    for (const flag of ['--exec-path', '--output', '--ext-diff', '--textconv']) {
      if (arg === flag || arg.startsWith(`${flag}=`)) return `\`git ${sub} ${flag}\` is not allowed`
    }
  }
  return null
}

function checkFind(args: string[]): string | null {
  const bad = args.find((arg) => FIND_FORBIDDEN.has(arg))
  return bad ? `\`find ${bad}\` is not allowed` : null
}

/** Validate a command for read-only `exec` and return the command to run, rewritten for git. */
export function checkReadOnlyCommand(command: string): ReadOnlyCheck {
  const lexed = tokenize(command.trim())
  if ('error' in lexed) return { ok: false, reason: lexed.error }
  const [head, ...rest] = lexed.tokens
  if (!head) return { ok: false, reason: 'empty command' }
  const name = head.value
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return { ok: false, reason: 'environment-variable assignments are not allowed' }
  if (!(READ_ONLY_COMMANDS as readonly string[]).includes(name) || head.quoted) {
    return { ok: false, reason: `\`${name}\` is not available in read-only mode; allowed commands: ${READ_ONLY_COMMANDS.join(', ')}` }
  }

  const args = rest.map((t) => t.value)
  const problem = name === 'rg' ? checkRg(args) : name === 'git' ? checkGit(args) : name === 'find' ? checkFind(args) : null
  if (problem) return { ok: false, reason: problem }

  if (name === 'rg') return { ok: true, command: ['rg', '--no-config', ...rest.map(quote)].join(' ') }
  if (name === 'git') {
    const [sub, ...subArgs] = rest
    const diffGuards = GIT_DIFF_SUBCOMMANDS.has(sub.value) ? (sub.value === 'blame' ? ['--no-textconv'] : ['--no-ext-diff', '--no-textconv']) : []
    return { ok: true, command: [...GIT_PREFIX, sub.value, ...diffGuards, ...subArgs.map(quote)].join(' ') }
  }
  return { ok: true, command: [name, ...rest.map(quote)].join(' ') }
}

export const READ_ONLY_EXEC_DESCRIPTION =
  'Run one read-only shell command for research. Allowed: ' +
  '`rg` (code search; prefer it for finding symbols, literals and error messages), ' +
  '`git log|show|blame|grep|diff|status|ls-files|rev-parse` (history: `git log -S <literal>` finds when a literal appeared, `git blame -L a,b <file>` explains a line range), ' +
  'and `ls`, `find`, `cat`, `head`, `tail`, `wc`. ' +
  'One command per call: no pipes, `;`, `&&`, redirects, `$()` or `cd`. Quote patterns with single quotes.'

function errorResult(error: string): AgentToolResult<any> {
  return { content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }], details: { error } }
}

const readOnlyExecTools = new WeakSet<AgentTool>()

/** Wrap the agent-mode `exec` tool so it only runs {@link checkReadOnlyCommand}-approved commands. Idempotent. */
export function createReadOnlyExecTool(exec: AgentTool): AgentTool {
  if (readOnlyExecTools.has(exec)) return exec
  const tool: AgentTool = {
    ...exec,
    description: READ_ONLY_EXEC_DESCRIPTION,
    execute: async (toolCallId, params, ...rest) => {
      const { command, ...others } = params as { command: string }
      const check = checkReadOnlyCommand(command ?? '')
      if (!check.ok) return errorResult(`Read-only mode: ${check.reason}.`)
      return exec.execute(toolCallId, { ...others, command: check.command } as any, ...rest)
    },
  }
  readOnlyExecTools.add(tool)
  return tool
}

/** Keep the tools named in `allowed`, with `exec` (when allowed) swapped for its read-only form. */
export function restrictToReadOnlyTools(tools: AgentTool[], allowed: ReadonlySet<string>): AgentTool[] {
  return tools
    .filter((t) => allowed.has(t.name))
    .map((t) => (t.name === 'exec' ? createReadOnlyExecTool(t) : t))
}
