// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Built-in Quick-Fix rules.
 *
 * A rule looks at the **failed command's** original command line + the
 * trailing N lines of its output, and emits zero or more
 * `QuickFixSuggestion`s when a pattern matches. The host's lightbulb
 * UI renders the suggestions; clicking one fires the rule's `action`.
 *
 * Three action kinds:
 *
 *   - `run` — the host invokes a "send to terminal" callback with the
 *     payload. Used for safe, undoable fixes (rerun, set upstream).
 *
 *   - `cmdk-fill` — the host opens its Cmd-K-style popover with the
 *     payload as the pre-filled text so the user reviews before
 *     pressing Enter. Used when the fix is "best guess" (npm install
 *     a module name we extracted, sudo-prefix a privileged command).
 *
 *   - `link` — open the payload as a URL (install pages, docs).
 *
 * `confidence` is a per-rule signal of how sure we are; the host can
 * show high-confidence rules with a brighter glyph or auto-execute.
 *
 * Rules are pure functions of (commandLine, outputTail, cwd) returning
 * suggestions — no I/O, no state. Hosts who want stateful suggestions
 * (e.g. "did the user dismiss this rule for this cwd before?") wrap
 * the engine output before rendering.
 */

import type { QuickFixRule, QuickFixSuggestion } from './quick-fix-engine'

// ─── helpers shared by built-in rules ───────────────────────────────

/**
 * Extract a port number from EADDRINUSE-style messages. Handles all
 * the shapes Node, Vite, and curl emit:
 *
 *   "EADDRINUSE: address already in use 0.0.0.0:3000"
 *   "EADDRINUSE: address already in use :::8080"
 *   "Error: listen EADDRINUSE: address already in use 127.0.0.1:5173"
 *   "Port 4321 is in use, trying another one..."
 */
export function extractPort(line: string): number | null {
  const m = /(?::|\bPort\s+)(\d{2,5})\b/i.exec(line)
  if (!m) return null
  const port = parseInt(m[1]!, 10)
  if (port < 1 || port > 65535) return null
  return port
}

/** Extract the missing module name from Node's MODULE_NOT_FOUND text. */
export function extractMissingModule(line: string): string | null {
  // Standard Node message: "Cannot find module 'foo'" or "Error: Cannot find module \"foo\""
  const m = /Cannot find module ['"]([^'"]+)['"]/.exec(line)
  if (!m) return null
  // Skip relative paths — those are user code, not a package.
  if (m[1]!.startsWith('.') || m[1]!.startsWith('/')) return null
  // Skip workspace-internal subpaths (foo/bar) — only the package root
  // is installable. Take the scope/name portion only.
  const name = m[1]!
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/')
    if (!scope || !pkg) return null
    return `${scope}/${pkg}`
  }
  return name.split('/')[0]!
}

/** Extract the missing executable name from "command not found" messages. */
export function extractMissingCommand(line: string): string | null {
  // bash:   "bash: foo: command not found"
  // zsh:    "zsh: command not found: foo"
  // fish:   "fish: Unknown command: foo"
  // pwsh:   "The term 'foo' is not recognized..."
  const re = [
    /^[\w/-]+:\s*([\w.-]+):\s*command not found/,
    /command not found:\s*([\w.-]+)/,
    /fish: Unknown command:\s*([\w.-]+)/,
    /The term '([\w.-]+)' is not recognized/,
  ]
  for (const r of re) {
    const m = r.exec(line)
    if (m) return m[1]!
  }
  return null
}

/** Extract the offending pathspec from git's "did not match any file" error. */
export function extractGitPathspec(line: string): string | null {
  const m = /pathspec ['"]([^'"]+)['"] did not match/.exec(line)
  return m ? m[1]! : null
}

// ─── built-in rules ────────────────────────────────────────────────

/** Killing the listener of a busy port with `lsof | xargs kill`. */
const EADDRINUSE: QuickFixRule = {
  id: 'eaddrinuse',
  label: 'Free the busy port and rerun',
  matches({ outputTail, commandLine }): QuickFixSuggestion[] {
    if (!/EADDRINUSE|address already in use|Port\s+\d+\s+is in use/i.test(outputTail)) return []
    const port = extractPort(outputTail)
    if (!port) return []
    return [{
      ruleId: 'eaddrinuse',
      title: `Kill the process on port ${port} and rerun`,
      confidence: 'high',
      action: {
        kind: 'run',
        // BSD lsof / GNU lsof differ in flag order — `-t -i :PORT` works
        // on both macOS and Linux. xargs without -r is fine because if
        // there's nothing to kill the original command will just fail
        // the same way again.
        payload: `lsof -t -i :${port} | xargs kill -9 ; ${commandLine}`,
      },
    }]
  },
}

/** `git push` with no upstream → set upstream + push. */
const GIT_NO_UPSTREAM: QuickFixRule = {
  id: 'git-no-upstream',
  label: 'Set upstream on push',
  matches({ outputTail, commandLine }): QuickFixSuggestion[] {
    if (!/^\s*git\s+push\b/.test(commandLine)) return []
    if (!/no upstream branch|has no upstream branch|--set-upstream/.test(outputTail)) return []
    return [{
      ruleId: 'git-no-upstream',
      title: 'Push with upstream set to origin',
      confidence: 'high',
      action: { kind: 'run', payload: 'git push -u origin HEAD' },
    }]
  },
}

/** Missing-module → npm install <pkg>. Review-first because we guessed the package manager. */
const NODE_MISSING_MODULE: QuickFixRule = {
  id: 'node-missing-module',
  label: 'Install the missing module',
  matches({ outputTail }): QuickFixSuggestion[] {
    const pkg = extractMissingModule(outputTail)
    if (!pkg) return []
    return [{
      ruleId: 'node-missing-module',
      title: `Install ${pkg}`,
      detail: 'Review-first: pick npm/yarn/pnpm/bun for your project.',
      confidence: 'medium',
      action: { kind: 'cmdk-fill', payload: `npm install ${pkg}` },
    }]
  },
}

/** Bad pathspec → suggest the branch list. */
const GIT_BAD_PATHSPEC: QuickFixRule = {
  id: 'git-bad-pathspec',
  label: 'Pick a real branch',
  matches({ outputTail }): QuickFixSuggestion[] {
    const ps = extractGitPathspec(outputTail)
    if (!ps) return []
    return [{
      ruleId: 'git-bad-pathspec',
      title: `List branches to find one similar to '${ps}'`,
      confidence: 'low',
      action: { kind: 'cmdk-fill', payload: 'git branch -a' },
    }]
  },
}

/** "command not found" → install page or sudo-apt hint. */
const COMMAND_NOT_FOUND: QuickFixRule = {
  id: 'command-not-found',
  label: 'Install the missing command',
  matches({ outputTail }): QuickFixSuggestion[] {
    const name = extractMissingCommand(outputTail)
    if (!name) return []
    const installDoc = WELL_KNOWN_INSTALL_DOCS[name]
    const out: QuickFixSuggestion[] = []
    if (installDoc) {
      out.push({
        ruleId: 'command-not-found',
        title: `Open install docs for ${name}`,
        confidence: 'high',
        action: { kind: 'link', payload: installDoc },
      })
    }
    out.push({
      ruleId: 'command-not-found',
      title: `Search the package manager for ${name}`,
      detail: 'Review-first: pick brew / apt / dnf / winget for your OS.',
      confidence: 'low',
      action: { kind: 'cmdk-fill', payload: `# install ${name}: brew install ${name}  |  apt install ${name}  |  winget install ${name}` },
    })
    return out
  },
}

/** EACCES on a file/dir → `sudo` retry (review-first). */
const PERMISSION_DENIED: QuickFixRule = {
  id: 'permission-denied',
  label: 'Retry with sudo',
  matches({ outputTail, commandLine }): QuickFixSuggestion[] {
    if (!/Permission denied|EACCES/i.test(outputTail)) return []
    if (commandLine.startsWith('sudo ')) return [] // already tried
    return [{
      ruleId: 'permission-denied',
      title: 'Re-run with sudo',
      detail: 'Review-first: confirm you intend to run this with elevated privileges.',
      confidence: 'medium',
      action: { kind: 'cmdk-fill', payload: `sudo ${commandLine}` },
    }]
  },
}

/** Well-known CLI install docs — extend as fix-categories grow. */
const WELL_KNOWN_INSTALL_DOCS: Record<string, string> = {
  gh: 'https://cli.github.com/',
  rg: 'https://github.com/BurntSushi/ripgrep#installation',
  bat: 'https://github.com/sharkdp/bat#installation',
  fd: 'https://github.com/sharkdp/fd#installation',
  fzf: 'https://github.com/junegunn/fzf#installation',
  jq: 'https://jqlang.github.io/jq/download/',
  curl: 'https://curl.se/download.html',
  docker: 'https://docs.docker.com/get-docker/',
  node: 'https://nodejs.org/',
  bun: 'https://bun.sh/',
  pnpm: 'https://pnpm.io/installation',
  yarn: 'https://yarnpkg.com/getting-started/install',
  python: 'https://www.python.org/downloads/',
  python3: 'https://www.python.org/downloads/',
  pip: 'https://pip.pypa.io/en/stable/installation/',
  pip3: 'https://pip.pypa.io/en/stable/installation/',
  cargo: 'https://www.rust-lang.org/tools/install',
  rustc: 'https://www.rust-lang.org/tools/install',
  go: 'https://go.dev/dl/',
  brew: 'https://brew.sh/',
}

/** The default rule set, in the order rules are evaluated. */
export const BUILT_IN_RULES: readonly QuickFixRule[] = [
  EADDRINUSE,
  GIT_NO_UPSTREAM,
  NODE_MISSING_MODULE,
  GIT_BAD_PATHSPEC,
  COMMAND_NOT_FOUND,
  PERMISSION_DENIED,
] as const
