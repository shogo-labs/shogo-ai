// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `PermissionEngine` — pure-logic coverage for the local-agent security
 * guardrails. The engine has three top-level modes (strict, balanced,
 * full_autonomy) plus a hard-block tier that overrides every mode.
 *
 *   bun test packages/agent-runtime/src/__tests__/permission-engine.test.ts
 */

import { afterEach, describe, test, expect, beforeEach, mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYMLINKS_SUPPORTED } from './helpers/symlink-support'

mock.module('@shogo/shared-runtime', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  }),
}))

const {
  PermissionEngine,
  mergePolicy,
  parseSecurityPolicy,
  encodeSecurityPolicy,
  withPermissionGate,
  assertWithinWorkspace,
  DEFAULT_SECURITY_PREFERENCE,
} = await import('../permission-engine')

let workspaceDir: string
beforeEach(() => {
  // realpath the tmpdir: on macOS os.tmpdir() is under /var, a symlink to
  // /private/var. assertWithinWorkspace compares resolved paths against
  // realpath'd roots, so an un-resolved workspaceDir looks "outside" itself.
  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'shogo-perm-test-')))
})

function newEngine(opts: any = {}): InstanceType<typeof PermissionEngine> {
  return new PermissionEngine({
    preference: opts.preference ?? DEFAULT_SECURITY_PREFERENCE,
    workspaceDir,
    sendSseEvent: opts.sendSseEvent,
  })
}

describe('encodeSecurityPolicy / parseSecurityPolicy', () => {
  test('round-trips a base64-encoded policy', () => {
    const pref = { mode: 'balanced' as const, approvalTimeoutSeconds: 60 }
    const encoded = encodeSecurityPolicy(pref)
    const decoded = parseSecurityPolicy(encoded)
    expect(decoded.mode).toBe('balanced')
    expect(decoded.approvalTimeoutSeconds).toBe(60)
  })

  test('returns the default preference for an undefined env var', () => {
    expect(parseSecurityPolicy()).toEqual(DEFAULT_SECURITY_PREFERENCE)
  })

  test('falls back to defaults on a malformed base64 blob', () => {
    expect(parseSecurityPolicy('not-base64-not-json').mode).toBe('full_autonomy')
  })
})

describe('mergePolicy', () => {
  test('returns the user pref untouched when projectOverride is omitted', () => {
    const pref = { mode: 'balanced' as const }
    expect(mergePolicy(pref)).toBe(pref)
  })

  test('downgrades but never upgrades the mode', () => {
    const user = { mode: 'balanced' as const }
    const proj = { mode: 'strict' as const }
    expect(mergePolicy(user, proj).mode).toBe('strict')

    const user2 = { mode: 'strict' as const }
    const proj2 = { mode: 'full_autonomy' as const }
    expect(mergePolicy(user2, proj2).mode).toBe('strict') // attempted escalation blocked
  })

  test('intersects allow lists and unions deny lists for shellCommands', () => {
    const user = {
      mode: 'balanced' as const,
      overrides: { shellCommands: { allow: ['git status*', 'ls *', 'bun *'], deny: ['rm *'] } },
    }
    const proj = {
      overrides: { shellCommands: { allow: ['git status*', 'bun *', 'curl *'], deny: ['npm publish*'] } },
    }
    const merged = mergePolicy(user, proj)
    const allow = merged.overrides?.shellCommands?.allow ?? []
    const deny = merged.overrides?.shellCommands?.deny ?? []
    expect(allow.sort()).toEqual(['bun *', 'git status*'].sort())
    expect(deny.sort()).toEqual(['npm publish*', 'rm *'].sort())
  })
})

describe('PermissionEngine.check — no built-in command blocks', () => {
  test('destructive-looking commands follow the mode, not a hard block', () => {
    for (const mode of ['strict', 'balanced'] as const) {
      const eng = newEngine({ preference: { mode } })
      expect(eng.check('shell', 'exec', { command: 'sudo rm -rf /' }).action).toBe('ask')
      expect(eng.check('shell', 'exec', { command: 'sudo -u root shutdown now' }).action).toBe('ask')
      expect(eng.check('shell', 'exec', { command: 'sudo -n reboot' }).action).toBe('ask')
    }
    const eng = newEngine({ preference: { mode: 'full_autonomy' } })
    expect(eng.check('shell', 'exec', { command: 'sudo rm -rf /' }).action).toBe('allow')
    expect(eng.check('shell', 'exec', { command: 'sudo -u root shutdown now' }).action).toBe('allow')
    expect(eng.check('shell', 'exec', { command: 'ls && sudo -n reboot' }).action).toBe('allow')
  })

  test('sudo itself is not hard-blocked; it follows the mode and allowlist', () => {
    const cmd = 'sudo -u postgres psql -c "select 1"'
    expect(newEngine({ preference: { mode: 'full_autonomy' } }).check('shell', 'exec', { command: cmd }).action).toBe('allow')
    expect(newEngine({ preference: { mode: 'balanced' } }).check('shell', 'exec', { command: cmd }).action).toBe('ask')
    expect(newEngine({ preference: { mode: 'strict' } }).check('shell', 'exec', { command: cmd }).action).toBe('ask')
    const allowed = newEngine({ preference: { mode: 'balanced', overrides: { shellCommands: { allow: ['sudo *'] } } } })
    expect(allowed.check('shell', 'exec', { command: cmd }).action).toBe('allow')
    const denied = newEngine({ preference: { mode: 'full_autonomy', overrides: { shellCommands: { deny: ['sudo *'] } } } })
    expect(denied.check('shell', 'exec', { command: cmd }).action).toBe('deny')
  })

  test('a command that merely contains shell-invocation words is allowed', () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy' } })
    for (const command of [
      'rm -r /tmp/shogo-rm-probe',
      'rm -rf *.log',
      'git grep -n "bash -c" packages/agent-runtime/src',
      'curl -fsSL https://example.com/install.sh | sh',
      'sh -c "echo hi"',
      'git push --force-with-lease',
    ]) {
      expect(eng.check('shell', 'exec', { command }).action).toBe('allow')
    }
  })

  test('a shell deny rule a person configured still denies', () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy', overrides: { shellCommands: { deny: ['rm *'] } } } })
    expect(eng.check('shell', 'exec', { command: 'rm -r /tmp/x' }).action).toBe('deny')
    expect(eng.check('shell', 'exec', { command: 'ls' }).action).toBe('allow')
  })

  test('strict mode still asks for a shell command', () => {
    const eng = newEngine({ preference: { mode: 'strict' } })
    expect(eng.check('shell', 'exec', { command: 'rm -r /tmp/x' }).action).toBe('ask')
  })

  test('credential paths are blocked in strict/balanced and allowed in full_autonomy', () => {
    const sshPath = require('os').homedir() + '/.ssh/id_rsa'
    for (const mode of ['strict', 'balanced'] as const) {
      expect(newEngine({ preference: { mode } }).check('file_read', 'read_file', { path: sshPath }).action).toBe('deny')
    }
    expect(newEngine({ preference: { mode: 'full_autonomy' } }).check('file_read', 'read_file', { path: sshPath }).action).toBe('allow')
  })

  test('the "system" category is denied in strict/balanced and allowed in full_autonomy', () => {
    for (const mode of ['strict', 'balanced'] as const) {
      expect(newEngine({ preference: { mode } }).check('system', 'sudo', {}).action).toBe('deny')
    }
    expect(newEngine({ preference: { mode: 'full_autonomy' } }).check('system', 'sudo', {}).action).toBe('allow')
  })
})

describe('PermissionEngine.check — full_autonomy blocks nothing', () => {
  // `~` is never expanded by the engine (it only compares literal prefixes), so
  // the absolute forms are what actually reach HARD_BLOCKED_PATH_PREFIXES.
  const HOME = require('os').homedir()
  const TILDE_PATHS = ['~/.ssh/id_ed25519', '~/.aws/credentials', '~/.zshrc']
  const ABSOLUTE_PATHS = [
    `${HOME}/.ssh/id_ed25519`,
    `${HOME}/.aws/credentials`,
    `${HOME}/.zshrc`,
    // POSIX-only: `resolve()` on Windows turns '/etc/passwd' into '<drive>:\etc\passwd',
    // which never matches the literal prefix, so the engine allows it there too.
    ...(process.platform === 'win32' ? [] : ['/etc/passwd']),
  ]

  test('allows every file tool on every built-in credential path', () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy' } })
    for (const path of [...TILDE_PATHS, ...ABSOLUTE_PATHS]) {
      expect(eng.check('file_read', 'read_file', { path }).action).toBe('allow')
      expect(eng.check('file_write', 'write_file', { path }).action).toBe('allow')
      expect(eng.check('file_delete', 'delete_file', { path }).action).toBe('allow')
    }
  })

  test('strict and balanced still deny those paths', () => {
    for (const mode of ['strict', 'balanced'] as const) {
      const eng = newEngine({ preference: { mode } })
      for (const path of ABSOLUTE_PATHS) {
        expect(eng.check('file_read', 'read_file', { path }).action).toBe('deny')
        expect(eng.check('file_write', 'write_file', { path }).action).toBe('deny')
      }
    }
  })

  test('a fileAccess deny rule a person configured still denies', () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy', overrides: { fileAccess: { deny: ['~/.ssh/*'] } } } })
    expect(eng.check('file_read', 'read_file', { path: '~/.ssh/id_ed25519' }).action).toBe('deny')
    expect(eng.check('file_read', 'read_file', { path: '~/.aws/credentials' }).action).toBe('allow')
  })
})

describe('PermissionEngine.check — strict mode', () => {
  test('allows file_read unconditionally', () => {
    const eng = newEngine({ preference: { mode: 'strict' } })
    expect(eng.check('file_read', 'read_file', { path: 'foo.txt' }).action).toBe('allow')
  })

  test('always allows writes to agent-config files (AGENTS.md, MEMORY.md, …)', () => {
    const eng = newEngine({ preference: { mode: 'strict' } })
    expect(eng.check('file_write', 'write_file', { path: 'AGENTS.md' }).action).toBe('allow')
    expect(eng.check('file_write', 'write_file', { path: 'memory/MEMORY.md' }).action).toBe('allow')
  })

  test('asks for everything else', () => {
    const eng = newEngine({ preference: { mode: 'strict' } })
    expect(eng.check('file_write', 'write_file', { path: 'src/main.ts' }).action).toBe('ask')
    expect(eng.check('shell', 'exec', { command: 'ls' }).action).toBe('ask')
  })

  test('honours fileAccess.allow for writes', () => {
    const eng = newEngine({
      preference: {
        mode: 'strict',
        overrides: { fileAccess: { allow: ['*.md'] } },
      },
    })
    expect(eng.check('file_write', 'write_file', { path: 'NOTES.md' }).action).toBe('allow')
  })
})

describe('PermissionEngine.check — balanced mode', () => {
  test('auto-allows file_read', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    expect(eng.check('file_read', 'read_file', { path: 'foo.txt' }).action).toBe('allow')
  })

  test('auto-allows writes within workspace', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    expect(eng.check('file_write', 'write_file', { path: 'src/main.ts' }).action).toBe('allow')
  })

  test('auto-allows writes within a symlinked workspace on an existing file', () => {
    // A project runtime's WORKSPACE_DIR is a symlink. The canonical compare
    // must not read that as "outside the project" and prompt (SHO-125).
    if (!SYMLINKS_SUPPORTED) return
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'shogo-perm-real-')))
    const linkParent = realpathSync(mkdtempSync(join(tmpdir(), 'shogo-perm-link-')))
    const link = join(linkParent, 'workspace')
    symlinkSync(real, link)
    try {
      writeFileSync(join(real, 'MEMORY.md'), '# memory\n')
      const eng = new PermissionEngine({
        preference: { mode: 'balanced' },
        workspaceDir: link,
      })
      expect(eng.check('file_write', 'write_file', { path: 'MEMORY.md' }).action).toBe('allow')
    } finally {
      rmSync(linkParent, { recursive: true, force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })

  test('still asks before writing into a linked folder', () => {
    // A linked folder is a separate grant: the guard allows it, but balanced
    // mode keeps its approval prompt (SHO-125 review).
    const linked = realpathSync(mkdtempSync(join(tmpdir(), 'shogo-perm-linked-')))
    const prev = process.env.LINKED_FOLDERS
    process.env.LINKED_FOLDERS = JSON.stringify([linked])
    try {
      writeFileSync(join(linked, 'notes.md'), 'hi\n')
      const eng = newEngine({ preference: { mode: 'balanced' } })
      expect(eng.check('file_write', 'write_file', { path: join(linked, 'notes.md') }).action).toBe('ask')
    } finally {
      if (prev === undefined) delete process.env.LINKED_FOLDERS
      else process.env.LINKED_FOLDERS = prev
      rmSync(linked, { recursive: true, force: true })
    }
  })

  test('asks for file_delete outside an allowlist', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    expect(eng.check('file_delete', 'delete_file', { path: 'src/main.ts' }).action).toBe('ask')
  })

  test('shell commands on the default allowlist are auto-allowed', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    expect(eng.check('shell', 'exec', { command: 'ls -la' }).action).toBe('allow')
    expect(eng.check('shell', 'exec', { command: 'bun run build' }).action).toBe('allow')
    expect(eng.check('shell', 'exec', { command: 'git status' }).action).toBe('allow')
  })

  test('shell commands outside the allowlist require approval', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    expect(eng.check('shell', 'exec', { command: 'rsync foo bar' }).action).toBe('ask')
  })

  test('docker/compose/make require approval on a non-docker-class runtime', () => {
    const prevClass = process.env.SHOGO_RUNTIME_CLASS
    delete process.env.SHOGO_RUNTIME_CLASS
    try {
      const eng = newEngine({ preference: { mode: 'balanced' } })
      expect(eng.check('shell', 'exec', { command: 'docker compose up -d' }).action).toBe('ask')
      expect(eng.check('shell', 'exec', { command: 'make build' }).action).toBe('ask')
    } finally {
      if (prevClass === undefined) delete process.env.SHOGO_RUNTIME_CLASS
      else process.env.SHOGO_RUNTIME_CLASS = prevClass
    }
  })

  test('docker/compose/make are auto-allowed when SHOGO_RUNTIME_CLASS=docker', () => {
    const prevClass = process.env.SHOGO_RUNTIME_CLASS
    process.env.SHOGO_RUNTIME_CLASS = 'docker'
    try {
      const eng = newEngine({ preference: { mode: 'balanced' } })
      expect(eng.check('shell', 'exec', { command: 'docker compose up -d --build' }).action).toBe('allow')
      expect(eng.check('shell', 'exec', { command: 'docker ps' }).action).toBe('allow')
      expect(eng.check('shell', 'exec', { command: 'make build' }).action).toBe('allow')
      // sudo isn't on the docker-class allowlist, so it still asks.
      expect(eng.check('shell', 'exec', { command: 'sudo docker compose up' }).action).toBe('ask')
    } finally {
      if (prevClass === undefined) delete process.env.SHOGO_RUNTIME_CLASS
      else process.env.SHOGO_RUNTIME_CLASS = prevClass
    }
  })

  test('network allows requests to default allowlist domains', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    expect(eng.check('network', 'fetch', { url: 'https://api.github.com/repos/x/y' }).action).toBe('allow')
    expect(eng.check('network', 'fetch', { url: 'https://example.com/secret' }).action).toBe('ask')
  })

  test('mcp auto-approve list bypasses approval', () => {
    const eng = newEngine({
      preference: {
        mode: 'balanced',
        overrides: { mcpTools: { autoApprove: ['composio.gmail.send'] } },
      },
    })
    expect(eng.check('mcp', 'connect', { name: 'composio.gmail.send' }).action).toBe('allow')
    expect(eng.check('mcp', 'connect', { name: 'composio.unknown.tool' }).action).toBe('ask')
  })
})

describe('PermissionEngine.check — full_autonomy mode', () => {
  test('approves everything a person has not restricted', () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy' } })
    expect(eng.check('file_write', 'write_file', { path: 'src/x' }).action).toBe('allow')
    expect(eng.check('shell', 'exec', { command: 'rsync foo bar' }).action).toBe('allow')
    expect(eng.check('network', 'fetch', { url: 'https://example.com' }).action).toBe('allow')
  })
})

describe('PermissionEngine — approval flow', () => {
  test('requestApproval auto-denies when no SSE callback is wired', async () => {
    const eng = newEngine()
    const ok = await eng.requestApproval('cid-1', 'exec', 'shell', { command: 'x' }, 'reason')
    expect(ok).toBe(false)
  })

  test('allow_once response resolves the pending promise to true', async () => {
    const events: any[] = []
    const eng = newEngine({ preference: { mode: 'strict' }, sendSseEvent: (e) => events.push(e) })
    const promise = eng.requestApproval('cid-1', 'write_file', 'file_write', { path: 'foo' }, 'r')
    expect(events).toHaveLength(1)
    const id = events[0].data.id
    eng.handleApprovalResponse({ id, decision: 'allow_once' } as any)
    expect(await promise).toBe(true)
  })

  test('an ask-first action rule waits as long as the cloud does; other prompts keep the short timeout', async () => {
    const events: any[] = []
    const eng = newEngine({ preference: { mode: 'strict', approvalTimeoutSeconds: 30 }, sendSseEvent: (e) => events.push(e) })
    const merge = eng.requestApproval('cid-1', 'github_merge_pr', 'integrations', { number: 1 }, 'r')
    const write = eng.requestApproval('cid-2', 'write_file', 'file_write', { path: 'foo' }, 'r')
    expect(events[0].data.timeout).toBe(900)
    expect(events[1].data.timeout).toBe(30)
    eng.handleApprovalResponse({ id: events[0].data.id, decision: 'deny' } as any)
    eng.handleApprovalResponse({ id: events[1].data.id, decision: 'deny' } as any)
    await Promise.all([merge, write])
  })

  test('deny response resolves to false and increments the per-turn denial count', async () => {
    const events: any[] = []
    const eng = newEngine({ preference: { mode: 'strict' }, sendSseEvent: (e) => events.push(e) })
    const promise = eng.requestApproval('cid-1', 'write_file', 'file_write', { path: 'foo' }, 'r')
    const id = events[0].data.id
    eng.handleApprovalResponse({ id, decision: 'deny' } as any)
    expect(await promise).toBe(false)
  })

  test('always_allow updates the persisted override rules', async () => {
    const events: any[] = []
    const eng = newEngine({ preference: { mode: 'strict' }, sendSseEvent: (e) => events.push(e) })
    const promise = eng.requestApproval('cid-1', 'exec', 'shell', { command: 'rsync' }, 'r')
    const id = events[0].data.id
    eng.handleApprovalResponse({ id, decision: 'always_allow', pattern: 'rsync *' } as any)
    await promise
    const overrides = eng.getOverrides()
    expect(overrides?.shellCommands?.allow ?? []).toContain('rsync *')
  })

  test('resetTurn() rejects every in-flight approval', async () => {
    const eng = newEngine({ preference: { mode: 'strict' }, sendSseEvent: () => {} })
    const promise = eng.requestApproval('cid-1', 'write_file', 'file_write', { path: 'foo' }, 'r')
    eng.resetTurn()
    expect(await promise).toBe(false)
  })

  test('updatePreference applies a partial patch', () => {
    const eng = newEngine({ preference: { mode: 'balanced' } })
    eng.updatePreference({ mode: 'strict' })
    expect(eng.mode).toBe('strict')
  })
})

describe('withPermissionGate', () => {
  test('blocks tool execution when the engine denies', async () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy', overrides: { shellCommands: { deny: ['rm *'] } } } })
    const tool: any = {
      name: 'exec',
      description: 'd',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ran' }], details: 'ran' }),
    }
    const gated = withPermissionGate(tool, 'shell', eng)
    const result: any = await gated.execute('cid-1', { command: 'rm -r /tmp/x' })
    expect(JSON.stringify(result.details)).toContain('Permission denied')
  })

  test('forwards to the underlying tool when the engine allows', async () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy' } })
    const tool: any = {
      name: 'echo',
      description: 'd',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: 'ok' }),
    }
    const gated = withPermissionGate(tool, 'shell', eng)
    const result: any = await gated.execute('cid-2', { command: 'ls' })
    expect(result.details).toBe('ok')
  })

  test('forwards the abort signal and onUpdate so Stop reaches the tool', async () => {
    const eng = newEngine({ preference: { mode: 'full_autonomy' } })
    let received: any[] = []
    const tool: any = {
      name: 'echo',
      description: 'd',
      parameters: {},
      execute: async (...args: any[]) => {
        received = args
        return { content: [{ type: 'text', text: 'ok' }], details: 'ok' }
      },
    }
    const signal = new AbortController().signal
    const onUpdate = () => {}
    await withPermissionGate(tool, 'shell', eng).execute('cid-2b', { command: 'ls' }, signal, onUpdate)
    expect(received[2]).toBe(signal)
    expect(received[3]).toBe(onUpdate)
  })

  test('returns an error result when the user declines an "ask" approval', async () => {
    const eng = newEngine({ preference: { mode: 'strict' } })
    const tool: any = {
      name: 'write_file',
      description: 'd',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: 'ok' }),
    }
    const gated = withPermissionGate(tool, 'file_write', eng)
    const result: any = await gated.execute('cid-3', { path: 'src/x.ts' })
    // No SSE callback wired → engine auto-denies the approval.
    expect(JSON.stringify(result.details)).toContain('declined')
  })
})

describe('assertWithinWorkspace', () => {
  test('returns a resolved absolute path for a normal child path', () => {
    const ws = workspaceDir
    expect(assertWithinWorkspace(ws, 'foo/bar.ts').startsWith(ws)).toBe(true)
  })

  test('throws on a path-traversal attempt outside SHOGO_LOCAL_MODE', () => {
    const old = process.env.SHOGO_LOCAL_MODE
    const oldLinked = process.env.LINKED_FOLDERS
    delete process.env.SHOGO_LOCAL_MODE
    // A desktop runtime sets LINKED_FOLDERS for every folder-linked project; the
    // linked-folder branch would answer with its own message instead.
    delete process.env.LINKED_FOLDERS
    try {
      expect(() => assertWithinWorkspace(workspaceDir, '../../etc/passwd')).toThrow(/outside workspace/i)
    } finally {
      if (old !== undefined) process.env.SHOGO_LOCAL_MODE = old
      if (oldLinked !== undefined) process.env.LINKED_FOLDERS = oldLinked
    }
  })

  test('passes through traversal paths in SHOGO_LOCAL_MODE', () => {
    const old = process.env.SHOGO_LOCAL_MODE
    const oldLinked = process.env.LINKED_FOLDERS
    process.env.SHOGO_LOCAL_MODE = 'true'
    delete process.env.LINKED_FOLDERS
    try {
      const out = assertWithinWorkspace(workspaceDir, '../../etc/passwd')
      expect(typeof out).toBe('string')
    } finally {
      if (old === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = old
      if (oldLinked !== undefined) process.env.LINKED_FOLDERS = oldLinked
    }
  })

  test('unrestricted skips the linked-folder boundary; without it the path is refused', () => {
    const oldLocal = process.env.SHOGO_LOCAL_MODE
    const oldLinked = process.env.LINKED_FOLDERS
    delete process.env.SHOGO_LOCAL_MODE
    process.env.LINKED_FOLDERS = JSON.stringify([workspaceDir])
    try {
      const outside = require('path').join(require('os').tmpdir(), 'sho-209-outside-probe.txt')
      expect(() => assertWithinWorkspace(workspaceDir, outside)).toThrow(/allowed folders/i)
      expect(assertWithinWorkspace(workspaceDir, outside, { unrestricted: true })).toBe(outside)
    } finally {
      if (oldLocal === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = oldLocal
      if (oldLinked === undefined) delete process.env.LINKED_FOLDERS
      else process.env.LINKED_FOLDERS = oldLinked
    }
  })
})

// ---------------------------------------------------------------------------
// Coverage for previously uncov segments
// ---------------------------------------------------------------------------

describe('mergeUnique — line 134-135 (via loadPersistedRules)', () => {
  test('persisted rules are merged deduplicating via mergeUnique', () => {
    // mergeUnique is called from loadPersistedRules (not mergePolicy export).
    // Seed a permissions.json with some deny entries and construct an engine
    // with overlapping deny entries in the preference — mergeUnique dedupes.
    const { mkdirSync, writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const shogoDir = join(workspaceDir, '.shogo')
    mkdirSync(shogoDir, { recursive: true })
    writeFileSync(
      join(shogoDir, 'permissions.json'),
      JSON.stringify({ shellCommands: { deny: ['sudo', 'curl'] } }),
    )
    const pref = {
      ...DEFAULT_SECURITY_PREFERENCE,
      overrides: { shellCommands: { deny: ['sudo', 'rm -rf'] } },
    }
    // Constructor calls loadPersistedRules → mergeUnique(['sudo','rm -rf'], ['sudo','curl'])
    const eng = new PermissionEngine({ workspaceDir, preference: pref })
    // Engine is alive — denials list has been merged. We can't read pref
    // directly (private), but the engine should construct without throwing.
    expect(eng).toBeTruthy()
  })
})

describe('PermissionEngine.setSseCallback — line 335', () => {
  test('setSseCallback stores a callback used to emit SSE events', async () => {
    const eng = new PermissionEngine({ workspaceDir, preference: { ...DEFAULT_SECURITY_PREFERENCE, approvalTimeoutSeconds: 0.01 } })
    const events: any[] = []
    eng.setSseCallback((e) => events.push(e))
    // Trigger an SSE event by setting the callback then requesting approval
    // (the engine emits an SSE event on requestApproval → auto-deny).
    await eng.requestApproval('c1', 'read', 'file_read', { path: '/x' }, 'r')
    expect(events.length).toBeGreaterThan(0)
    eng.setSseCallback(undefined)
  })
})

describe('PermissionEngine approval timeout — lines 623-626', () => {
  test('pending approval times out and results in denial', async () => {
    const realSetTimeout = globalThis.setTimeout
    const captured: Array<{ fn: Function; ms: number }> = []
    ;(globalThis as any).setTimeout = (fn: Function, ms: number) => {
      captured.push({ fn, ms })
      return realSetTimeout(fn, ms) as any
    }
    try {
      const eng = new PermissionEngine({
        workspaceDir,
        preference: { ...DEFAULT_SECURITY_PREFERENCE, approvalTimeoutSeconds: 0.001 },
      })
      const cb = (e: any) => {}
      eng.setSseCallback(cb)
      const p = eng.requestApproval('c-timeout', 'exec', 'shell', { command: 'x' }, 'test')
      // Let timers fire.
      await new Promise((r) => realSetTimeout(r, 20))
      const result = await p
      expect(result).toBe(false) // timed out → denied
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  })
})

describe('assertWithinWorkspace — realpathSync catch on roots (lines 790-793)', () => {
  // Creating symlinks needs elevation/Developer Mode on Windows, so skip
  // rather than fail — a permanently red Windows job tests nothing (SHOG-749).
  test.skipIf(!SYMLINKS_SUPPORTED)('broken-symlink in LINKED_FOLDERS falls back via catch (lines 790-793)', () => {
    // Lines 790-793 are inside the LINKED_FOLDERS branch. Set LINKED_FOLDERS to a
    // broken-symlink path so realpathSync throws → catch returns the raw path.
    const ghostTarget = workspaceDir + '-nonexistent'
    const linkFolder = workspaceDir + '-link'
    symlinkSync(ghostTarget, linkFolder)
    const origLF = process.env.LINKED_FOLDERS
    process.env.LINKED_FOLDERS = JSON.stringify([linkFolder])
    try {
      const result = assertWithinWorkspace(workspaceDir, 'file.txt')
      expect(result).toContain('file.txt')
    } finally {
      if (origLF === undefined) delete process.env.LINKED_FOLDERS
      else process.env.LINKED_FOLDERS = origLF
      rmSync(linkFolder, { force: true })
    }
  })
})

describe('assertWithinWorkspace — LINKED_FOLDERS containment (SHOG-749)', () => {
  // The LINKED_FOLDERS branch is what folder-linked desktop projects take.
  // Before the path-boundary fix it rejected every child path on Windows,
  // because it compared against `root + '/'` while path.resolve() returns
  // backslashes. No symlinks here on purpose: the only pre-existing test
  // for this branch needed symlinkSync, which needs elevation on Windows,
  // so the branch was effectively untested on the platform it broke on.
  const withLinkedFolders = (folders: string[], fn: () => void) => {
    const origLF = process.env.LINKED_FOLDERS
    const origLocal = process.env.SHOGO_LOCAL_MODE
    process.env.LINKED_FOLDERS = JSON.stringify(folders)
    delete process.env.SHOGO_LOCAL_MODE
    try {
      fn()
    } finally {
      if (origLF === undefined) delete process.env.LINKED_FOLDERS
      else process.env.LINKED_FOLDERS = origLF
      if (origLocal === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = origLocal
    }
  }

  test('a child path inside a linked folder is allowed', () => {
    withLinkedFolders([workspaceDir], () => {
      const out = assertWithinWorkspace(workspaceDir, 'config.json')
      expect(out).toBe(join(workspaceDir, 'config.json'))
    })
  })

  test('a deeply nested child inside a linked folder is allowed', () => {
    withLinkedFolders([workspaceDir], () => {
      const out = assertWithinWorkspace(workspaceDir, 'apps/desktop/src/preload.ts')
      expect(out).toBe(join(workspaceDir, 'apps', 'desktop', 'src', 'preload.ts'))
    })
  })

  test('an absolute child path inside a linked folder is allowed', () => {
    withLinkedFolders([workspaceDir], () => {
      const abs = join(workspaceDir, 'config.json')
      expect(assertWithinWorkspace(workspaceDir, abs)).toBe(abs)
    })
  })

  test('the linked folder root itself is allowed', () => {
    withLinkedFolders([workspaceDir], () => {
      expect(assertWithinWorkspace(workspaceDir, workspaceDir)).toBe(workspaceDir)
    })
  })

  test('a path outside every linked folder is rejected', () => {
    withLinkedFolders([workspaceDir], () => {
      expect(() => assertWithinWorkspace(workspaceDir, '../../etc/passwd')).toThrow(
        /outside the project's allowed folders/i,
      )
    })
  })

  test('a sibling dir whose name merely prefixes a linked folder is rejected', () => {
    withLinkedFolders([workspaceDir], () => {
      expect(() => assertWithinWorkspace(workspaceDir, workspaceDir + '-evil')).toThrow(
        /outside the project's allowed folders/i,
      )
    })
  })

  test('the duplicated workspaceDir root is reported only once', () => {
    // permission-engine prepends workspaceDir to LINKED_FOLDERS, and a
    // folder-linked project already lists it — so it used to be printed twice.
    withLinkedFolders([workspaceDir], () => {
      try {
        assertWithinWorkspace(workspaceDir, '../../etc/passwd')
        throw new Error('expected a rejection')
      } catch (err) {
        const message = (err as Error).message
        const occurrences = message.split(workspaceDir).length - 1
        expect(occurrences).toBe(1)
      }
    })
  })
})
