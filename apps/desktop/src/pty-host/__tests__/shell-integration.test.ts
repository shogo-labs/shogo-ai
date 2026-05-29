// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the shell-integration injector.
 *
 * No real shell is spawned — we exercise the planner only. The
 * planner's job is:
 *   - detect the shell kind from a path,
 *   - lay down the correct files for that kind,
 *   - return a transformed SpawnOptions ready for node-pty,
 *   - honour the SHOGO_DISABLE_SHELL_INTEGRATION opt-out,
 *   - cleanup() the temp directory exactly once and idempotently.
 *
 * End-to-end "spawn bash; assert OSC 633 marks emitted" coverage will
 * land alongside the renderer's OSC633Tracker tests, where we already
 * have deterministic fakes — running real node-pty would require the
 * native build (deferred per Phase 2 verify notes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyShellIntegration,
  detectShellKind,
  isConptyOscCapable,
  sanitiseBashArgs,
  stripArgs,
  type SpawnOptionsLike,
} from '../shell-integration'

// ─── helpers ────────────────────────────────────────────────────────────

let TMP_ROOT: string

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'shogo-si-test-'))
})

afterEach(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }) } catch { /* */ }
})

function baseInput(over: Partial<SpawnOptionsLike> = {}): SpawnOptionsLike {
  return {
    shell: '/bin/bash',
    args: [],
    cwd: '/tmp',
    // Tests cover the *applied* code paths, so they all opt in. The
    // top-level default (set by applyShellIntegration) is now opt-in
    // pending Phase 6 hardening of the OSC 633 scripts.
    env: { HOME: '/home/u', PATH: '/usr/bin', SHOGO_ENABLE_SHELL_INTEGRATION: '1' },
    cols: 80,
    rows: 24,
    ...over,
  }
}

// ─── detectShellKind ────────────────────────────────────────────────────

describe('detectShellKind', () => {
  it.each([
    ['/bin/bash', 'bash'],
    ['/usr/local/bin/bash', 'bash'],
    ['/bin/sh', 'bash'],
    ['/bin/zsh', 'zsh'],
    ['/usr/local/bin/zsh-5.9', 'zsh'],
    ['/usr/bin/fish', 'fish'],
    ['/usr/local/bin/pwsh', 'pwsh'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh'],
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'unknown'],
    ['/bin/dash', 'unknown'],
    ['', 'unknown'],
  ])('detects %s → %s', (shellPath, expected) => {
    expect(detectShellKind(shellPath)).toBe(expected)
  })
})

// ─── opt-outs ───────────────────────────────────────────────────────────

describe('applyShellIntegration — opt-outs', () => {
  it('returns status=disabled-by-env when SHOGO_DISABLE_SHELL_INTEGRATION=1', () => {
    const plan = applyShellIntegration(
      baseInput({ env: { SHOGO_DISABLE_SHELL_INTEGRATION: '1' } }),
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.status).toBe('disabled-by-env')
    expect(plan.artifacts).toEqual([])
    // spawn passes through unmodified
    expect(plan.spawn.args).toEqual([])
    expect(plan.spawn.env.SHOGO_TERMINAL).toBeUndefined()
    expect(readdirSync(TMP_ROOT)).toEqual([])
  })

  it('returns status=disabled-by-default when neither opt-in nor opt-out is set (Phase 6 hardening guard)', () => {
    const plan = applyShellIntegration(
      // Note: env has neither SHOGO_ENABLE_SHELL_INTEGRATION nor SHOGO_DISABLE_*
      {
        shell: '/bin/bash', args: [], cwd: '/tmp',
        env: { HOME: '/home/u', PATH: '/usr/bin' },
        cols: 80, rows: 24,
      },
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.status).toBe('disabled-by-default')
    expect(plan.artifacts).toEqual([])
    // Spawn passes through unmodified — exactly what we need for the
    // terminal to print a real prompt and accept input.
    expect(plan.spawn.args).toEqual([])
    expect(plan.spawn.env.SHOGO_TERMINAL).toBeUndefined()
    expect(readdirSync(TMP_ROOT)).toEqual([])
  })

  it('returns status=disabled-by-option when opts.disabled=true', () => {
    const plan = applyShellIntegration(baseInput(), { tmpRoot: TMP_ROOT, disabled: true })
    expect(plan.status).toBe('disabled-by-option')
    expect(plan.artifacts).toEqual([])
  })

  it('returns status=unsupported-shell for /bin/dash', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/dash' }), { tmpRoot: TMP_ROOT })
    expect(plan.status).toBe('unsupported-shell')
    expect(plan.artifacts).toEqual([])
  })

  it('returns status=windows-powershell-5 for powershell.exe', () => {
    const plan = applyShellIntegration(
      baseInput({ shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.status).toBe('windows-powershell-5')
  })
})

// ─── bash ───────────────────────────────────────────────────────────────

describe('applyShellIntegration — bash', () => {
  it('writes wrapper rcfile + integration, prepends --rcfile, strips user --rcfile/--norc', () => {
    const plan = applyShellIntegration(
      baseInput({ shell: '/bin/bash', args: ['--rcfile', '/etc/their-rc', '--norc', '-i'] }),
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.status).toBe('applied')
    expect(plan.kind).toBe('bash')
    expect(plan.spawn.args[0]).toBe('--rcfile')
    // user --rcfile + --norc gone, -i preserved
    expect(plan.spawn.args).not.toContain('--norc')
    expect(plan.spawn.args.includes('/etc/their-rc')).toBe(false)
    expect(plan.spawn.args).toContain('-i')

    const rcPath = plan.spawn.args[1]!
    expect(existsSync(rcPath)).toBe(true)
    const rc = readFileSync(rcPath, 'utf8')
    expect(rc).toContain('.bashrc')
    expect(rc).toContain('shogo-bash-integration.sh')
  })

  it('sets TERM_PROGRAM=shogo and the announce envs', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/bash' }), { tmpRoot: TMP_ROOT })
    expect(plan.spawn.env.TERM_PROGRAM).toBe('shogo')
    expect(plan.spawn.env.SHOGO_TERMINAL).toBe('1')
    expect(plan.spawn.env.SHOGO_SHELL_INTEGRATION).toBe('1')
  })

  it('integration script uses OSC 633 and the bash-preexec DEBUG-trap idiom', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/bash' }), { tmpRoot: TMP_ROOT })
    const intPath = plan.artifacts.find((p) => p.endsWith('shogo-bash-integration.sh'))!
    const body = readFileSync(intPath, 'utf8')
    expect(body).toContain('\\033]633;')
    expect(body).toContain('trap')
    expect(body).toContain('DEBUG')
    // Never replaces PROMPT_COMMAND — only appends.
    expect(body).toMatch(/PROMPT_COMMAND=.*__shogo_postexec/)
    expect(body).not.toMatch(/^PROMPT_COMMAND='__shogo_postexec'$/m) // not the only-line form
  })
})

// ─── zsh ────────────────────────────────────────────────────────────────

describe('applyShellIntegration — zsh', () => {
  it('writes ALL 5 dotfiles to a temp ZDOTDIR', () => {
    const plan = applyShellIntegration(
      baseInput({ shell: '/bin/zsh', env: { HOME: '/h', ZDOTDIR: '/h/zdot', SHOGO_ENABLE_SHELL_INTEGRATION: '1' } }),
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.status).toBe('applied')
    expect(plan.kind).toBe('zsh')
    const zdot = plan.spawn.env.ZDOTDIR
    expect(zdot && existsSync(join(zdot, '.zshenv'))).toBe(true)
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout']) {
      expect(existsSync(join(zdot, name))).toBe(true)
    }
    expect(plan.spawn.env._SHOGO_ORIG_ZDOTDIR).toBe('/h/zdot')
  })

  it('falls back to HOME when user has no ZDOTDIR', () => {
    const plan = applyShellIntegration(
      baseInput({ shell: '/bin/zsh', env: { HOME: '/h', SHOGO_ENABLE_SHELL_INTEGRATION: '1' } }),
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.spawn.env._SHOGO_ORIG_ZDOTDIR).toBe('/h')
  })

  it('every dotfile sources the user\'s equivalent before our hooks', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/zsh' }), { tmpRoot: TMP_ROOT })
    const zdot = plan.spawn.env.ZDOTDIR!
    for (const [name, marker] of [
      ['.zshenv', '.zshenv'],
      ['.zprofile', '.zprofile'],
      ['.zshrc', '.zshrc'],
      ['.zlogin', '.zlogin'],
      ['.zlogout', '.zlogout'],
    ] as const) {
      const body = readFileSync(join(zdot, name), 'utf8')
      expect(body).toContain(marker)
    }
  })

  it('.zshrc installs precmd/preexec hooks and wraps PS1', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/zsh' }), { tmpRoot: TMP_ROOT })
    const zshrc = readFileSync(join(plan.spawn.env.ZDOTDIR!, '.zshrc'), 'utf8')
    expect(zshrc).toContain('add-zsh-hook preexec')
    expect(zshrc).toContain('add-zsh-hook precmd')
    expect(zshrc).toContain('PS1=')
    // Uses %{...%} prompt-width-safe wrapper
    expect(zshrc).toContain('%{')
  })

  // Regression: .zshenv used to redirect ZDOTDIR back to the user's HOME
  // before zsh sourced our .zshrc, so our hooks NEVER installed and the
  // terminal showed an empty grid with no OSC marks. Bare `ZDOTDIR=` lines
  // are banned in .zshenv. Parameter expansions like ${ZDOTDIR:-$HOME} are
  // fine (they don't assign).
  it('.zshenv must NOT mutate ZDOTDIR (else our .zshrc is skipped)', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/zsh' }), { tmpRoot: TMP_ROOT })
    const zshenv = readFileSync(join(plan.spawn.env.ZDOTDIR!, '.zshenv'), 'utf8')
    const codeOnly = zshenv.replace(/^\s*#.*$/gm, '')
    const badAssignments = codeOnly.match(/^\s*(export\s+)?ZDOTDIR=/gm)
    expect(badAssignments).toBeNull()
  })

  // Regression: PS1 wrap used to PREPEND the OSC 633 ;B (prompt-end) mark,
  // putting it BEFORE the user's prompt characters. OSC 633 contract is
  // A …user prompt… B, so B goes at the END of PS1.
  it('.zshrc PS1 wrap APPENDS the prompt-end OSC mark (not prepend)', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/zsh' }), { tmpRoot: TMP_ROOT })
    const zshrc = readFileSync(join(plan.spawn.env.ZDOTDIR!, '.zshrc'), 'utf8')
    const wrap = zshrc.match(/^\s*PS1=.*$/m)?.[0]
    expect(wrap).toBeDefined()
    const ps1Idx = wrap!.indexOf('${PS1}')
    const endIdx = wrap!.indexOf('__shogo_prompt_end')
    expect(ps1Idx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(ps1Idx)
  })

  // Same regression for bash — same OSC contract, same prepend bug.
  // The PS1 wrap lives in the integration script (shogo-bash-integration.sh)
  // that the wrapper rcfile sources, NOT in the wrapper rcfile itself.
  it('bash.sh PS1 wrap APPENDS the prompt-end OSC mark (not prepend)', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/bash' }), { tmpRoot: TMP_ROOT })
    const wrapperRc = plan.spawn.args[1]!
    const intPath = join(wrapperRc, '..', 'shogo-bash-integration.sh')
    const rcfile = readFileSync(intPath, 'utf8')
    const wrap = rcfile.match(/^\s*PS1=.*$/m)?.[0]
    expect(wrap).toBeDefined()
    const ps1Idx = wrap!.indexOf('${PS1}')
    const endIdx = wrap!.indexOf('__shogo_prompt_end')
    expect(ps1Idx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(ps1Idx)
  })
})

// ─── fish ───────────────────────────────────────────────────────────────

describe('applyShellIntegration — fish', () => {
  it('writes integration to <xdg>/fish/conf.d/shogo-integration.fish', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/usr/bin/fish' }), { tmpRoot: TMP_ROOT })
    expect(plan.status).toBe('applied')
    const xdg = plan.spawn.env.XDG_CONFIG_HOME!
    const intPath = join(xdg, 'fish', 'conf.d', 'shogo-integration.fish')
    expect(existsSync(intPath)).toBe(true)
    const body = readFileSync(intPath, 'utf8')
    expect(body).toContain('--on-event fish_preexec')
    expect(body).toContain('--on-event fish_postexec')
  })

  it('emits a passthrough conf.d entry sourcing the user\'s config.fish', () => {
    const plan = applyShellIntegration(
      baseInput({ shell: '/usr/bin/fish', env: { HOME: '/h', XDG_CONFIG_HOME: '/h/.config-custom', SHOGO_ENABLE_SHELL_INTEGRATION: '1' } }),
      { tmpRoot: TMP_ROOT },
    )
    const through = plan.artifacts.find((p) => p.endsWith('00-shogo-passthrough.fish'))!
    const body = readFileSync(through, 'utf8')
    expect(body).toContain('/h/.config-custom/fish/config.fish')
  })
})

// ─── pwsh ───────────────────────────────────────────────────────────────

describe('applyShellIntegration — pwsh', () => {
  it('writes wrapper profile + integration; spawns with -NoExit -Command \". <wrapper>\"', () => {
    const plan = applyShellIntegration(
      baseInput({ shell: '/usr/local/bin/pwsh' }),
      { tmpRoot: TMP_ROOT },
    )
    expect(plan.status).toBe('applied')
    expect(plan.kind).toBe('pwsh')
    expect(plan.spawn.args[0]).toBe('-NoExit')
    expect(plan.spawn.args).toContain('-Command')
    const cmdIdx = plan.spawn.args.indexOf('-Command')
    const cmd = plan.spawn.args[cmdIdx + 1]!
    expect(cmd).toContain('shogo-pwsh-profile.ps1')

    const wrapperPath = plan.artifacts.find((p) => p.endsWith('shogo-pwsh-profile.ps1'))!
    const body = readFileSync(wrapperPath, 'utf8')
    expect(body).toContain('PROFILE.CurrentUserCurrentHost')
    expect(body).toContain('shogo-pwsh-integration.ps1')

    const intBody = readFileSync(
      plan.artifacts.find((p) => p.endsWith('shogo-pwsh-integration.ps1'))!,
      'utf8',
    )
    expect(intBody).toContain(']633;')
    expect(intBody).toContain('PSReadLine')
  })
})

// ─── cleanup ────────────────────────────────────────────────────────────

describe('applyShellIntegration — cleanup', () => {
  it('removes the temp directory and is idempotent', () => {
    const plan = applyShellIntegration(baseInput({ shell: '/bin/zsh' }), { tmpRoot: TMP_ROOT })
    const root = plan.artifacts[0]!
    expect(existsSync(root)).toBe(true)
    plan.cleanup()
    expect(existsSync(root)).toBe(false)
    // Double-call must not throw.
    plan.cleanup()
    expect(existsSync(root)).toBe(false)
  })

  it('passthrough plans have a no-op cleanup', () => {
    const plan = applyShellIntegration(
      baseInput({ env: { SHOGO_DISABLE_SHELL_INTEGRATION: '1' } }),
      { tmpRoot: TMP_ROOT },
    )
    // Must not throw and must not create anything.
    plan.cleanup()
    expect(readdirSync(TMP_ROOT)).toEqual([])
  })
})

// ─── arg sanitisers ─────────────────────────────────────────────────────

describe('stripArgs / sanitiseBashArgs', () => {
  it('stripArgs removes the flag and N following values', () => {
    expect(stripArgs(['--rcfile', '/x', '-i'], ['--rcfile'], 1)).toEqual(['-i'])
    expect(stripArgs(['--norc', '-i'], ['--norc'], 0)).toEqual(['-i'])
  })

  it('sanitiseBashArgs strips --rcfile <X>, --norc, --noprofile and prepends', () => {
    const out = sanitiseBashArgs(
      ['--rcfile', '/x', '--norc', '--noprofile', '-i'],
      ['--rcfile', '/tmp/new'],
    )
    expect(out).toEqual(['--rcfile', '/tmp/new', '-i'])
  })
})

// ─── ConPTY gate ────────────────────────────────────────────────────────

describe('isConptyOscCapable', () => {
  it('returns true on non-Windows', () => {
    if (process.platform === 'win32') return
    expect(isConptyOscCapable()).toBe(true)
  })
})

// ─── Nushell ────────────────────────────────────────────────────────────
//
// Nushell support added in Round 2. We verify:
//   1. Detection: 'nu' and 'nushell' both map to the 'nushell' kind.
//   2. `apply()` lays down a config wrapper + integration script when
//      SHOGO_ENABLE_SHELL_INTEGRATION=1 and rewrites argv to pass
//      `--config <wrapper>`.
//   3. The wrapper sources the user's `~/.config/nushell/config.nu`
//      (if HOME is set) before our integration script.
//   4. The integration script content starts with the expected header.
//   5. The opt-out env var still short-circuits.

describe('Nushell shell integration', () => {
  it('detects nu and nushell basenames', () => {
    expect(detectShellKind('/usr/local/bin/nu')).toBe('nushell')
    expect(detectShellKind('nu')).toBe('nushell')
    expect(detectShellKind('/opt/nushell')).toBe('nushell')
    expect(detectShellKind('C:\\nushell\\nu.exe')).toBe('nushell')
  })

  it('apply() materialises wrapper + integration scripts and rewrites argv', () => {
    const input: SpawnOptionsLike = {
      shell: '/usr/local/bin/nu',
      args: ['--interactive'],
      cwd: '/tmp',
      env: { HOME: '/home/u', SHOGO_ENABLE_SHELL_INTEGRATION: '1' },
      cols: 80,
      rows: 24,
    }
    const plan = applyShellIntegration(input, { tmpRoot: TMP_ROOT })
    expect(plan.kind).toBe('nushell')
    expect(plan.status).toBe('applied')
    expect(plan.spawn.args[0]).toBe('--config')
    const wrapperPath = plan.spawn.args[1]
    expect(wrapperPath.endsWith('shogo-nu-config.nu')).toBe(true)
    expect(plan.spawn.args.slice(2)).toEqual(['--interactive'])
    expect(existsSync(wrapperPath)).toBe(true)
    const wrapperContent = readFileSync(wrapperPath, 'utf8')
    expect(wrapperContent).toContain('/home/u/.config/nushell/config.nu')
    expect(wrapperContent).toContain('shogo-nu-integration.nu')
    const intPath = plan.artifacts.find((p) => p.endsWith('shogo-nu-integration.nu'))!
    expect(existsSync(intPath)).toBe(true)
    const intContent = readFileSync(intPath, 'utf8')
    expect(intContent).toContain('shogo shell integration — Nushell')
    expect(intContent).toContain('__shogo_osc633')
    plan.cleanup()
    expect(existsSync(intPath)).toBe(false)
  })

  it('honours $XDG_CONFIG_HOME for user config path', () => {
    const input: SpawnOptionsLike = {
      shell: '/usr/local/bin/nushell',
      args: [],
      cwd: '/tmp',
      env: {
        HOME: '/home/u',
        XDG_CONFIG_HOME: '/etc/cfg',
        SHOGO_ENABLE_SHELL_INTEGRATION: '1',
      },
      cols: 80,
      rows: 24,
    }
    const plan = applyShellIntegration(input, { tmpRoot: TMP_ROOT })
    const wrapperContent = readFileSync(plan.spawn.args[1], 'utf8')
    expect(wrapperContent).toContain('/etc/cfg/nushell/config.nu')
    plan.cleanup()
  })

  it('SHOGO_DISABLE_SHELL_INTEGRATION=1 short-circuits to passthrough', () => {
    const input: SpawnOptionsLike = {
      shell: '/usr/local/bin/nu',
      args: ['--interactive'],
      cwd: '/tmp',
      env: {
        SHOGO_ENABLE_SHELL_INTEGRATION: '1',
        SHOGO_DISABLE_SHELL_INTEGRATION: '1',
      },
      cols: 80,
      rows: 24,
    }
    const plan = applyShellIntegration(input, { tmpRoot: TMP_ROOT })
    expect(plan.status).toBe('disabled-by-env')
    expect(plan.spawn.args).toEqual(['--interactive'])
    expect(plan.artifacts).toEqual([])
  })

  it('default opt-in gate (no SHOGO_ENABLE_SHELL_INTEGRATION) passes through', () => {
    const input: SpawnOptionsLike = {
      shell: '/usr/local/bin/nu',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    }
    const plan = applyShellIntegration(input, { tmpRoot: TMP_ROOT })
    expect(plan.status).toBe('disabled-by-default')
    expect(plan.kind).toBe('nushell')
  })
})
