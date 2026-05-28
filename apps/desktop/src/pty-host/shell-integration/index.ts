// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shell-integration injector.
 *
 * Given a `SpawnOptions` for a PTY about to be spawned, this module
 * returns a `ShellIntegrationPlan` describing:
 *
 *   - the shell kind we detected (bash/zsh/fish/pwsh/unknown),
 *   - whether integration was applied or skipped (and why — `disabled`,
 *     `unsupported-shell`, `windows-powershell`, etc.),
 *   - the **transformed** SpawnOptions to actually hand to node-pty,
 *   - a `cleanup()` that the session calls on exit to remove any
 *     temp files we wrote.
 *
 * Why a separate module instead of inlining in `pty-session.ts`:
 *   - lets us unit-test the injection logic with zero `node-pty`
 *     involvement,
 *   - keeps the file-system side-effects (mkdtemp, writeFileSync,
 *     fchmodSync) out of the spawn hot path's call tree,
 *   - lets `apply()` return synchronously — important because the
 *     existing host code in `pty-host.ts` is also synchronous up to
 *     `new PtySession(...)`.
 *
 * The shell scripts themselves live as plain `.sh / .zsh / .fish /
 * .ps1` files under `./scripts/` so editing them lights up the right
 * editor syntax highlighting. We slurp them at module-load time via
 * `readFileSync` so the running utilityProcess (after Phase 1's esbuild
 * bundle) still has the strings without needing a runtime FS read.
 */

import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, release as osRelease } from 'node:os'
import { join } from 'node:path'
import {
  BASH,
  ZSH_ENV,
  ZSH_PROFILE,
  ZSH_RC,
  ZSH_LOGIN,
  ZSH_LOGOUT,
  FISH,
  PWSH,
} from './embedded-scripts.generated'

// Shell-integration scripts are embedded as TS string constants by
// scripts/generate-shell-integration-embeds.mjs (committed alongside
// the source .sh / .zsh / .fish / .ps1 files), so the bundled
// pty-host.js ships as a single file and unit tests need no FS access.

// ─── public types ───────────────────────────────────────────────────────

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'unknown'

export type ShellIntegrationStatus =
  | 'applied'
  | 'disabled-by-env'
  | 'disabled-by-option'
  | 'disabled-by-default'
  | 'unsupported-shell'
  | 'windows-powershell-5'
  | 'conpty-too-old'

export interface ShellIntegrationOptions {
  /** Pass `true` to skip injection entirely (e.g. for restore-from-snapshot). */
  disabled?: boolean
  /**
   * Override $TMPDIR for tests. Default: `os.tmpdir()`. The injector
   * `mkdtempSync`s a unique directory underneath this for each session.
   */
  tmpRoot?: string
}

export interface SpawnOptionsLike {
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  restoreId?: string
}

export interface ShellIntegrationPlan<T extends SpawnOptionsLike = SpawnOptionsLike> {
  /** The shell kind we detected. */
  kind: ShellKind
  /** Whether we applied integration, and if not, why not. */
  status: ShellIntegrationStatus
  /** The SpawnOptions to actually hand to node-pty. */
  spawn: T
  /**
   * Absolute paths the injector created on disk. Empty when
   * `status !== 'applied'`. `cleanup()` removes these in one shot.
   */
  artifacts: string[]
  /** Removes any temp files created by `apply()`. Idempotent. */
  cleanup(): void
}

// ─── public API ─────────────────────────────────────────────────────────

/**
 * Detect the shell kind from an absolute path or PATH-resolvable name.
 * We match on the basename — `/usr/local/bin/zsh-5.9` → `zsh`,
 * `pwsh.exe` → `pwsh`. Anything we don't recognise → `unknown`.
 */
export function detectShellKind(shellPath: string): ShellKind {
  const name = shellBasename(shellPath)
  if (name === 'bash' || name === 'sh' || name.endsWith('-bash')) return 'bash'
  if (name === 'zsh' || /^zsh[-_]/.test(name) || name.endsWith('-zsh')) return 'zsh'
  if (name === 'fish') return 'fish'
  if (name === 'pwsh') return 'pwsh'
  // Windows PowerShell 5.x — detected separately so we can return a
  // distinct status. Caller treats `powershell` as unsupported.
  if (name === 'powershell') return 'unknown'
  return 'unknown'
}

/**
 * Cross-platform basename. node:path's `basename` only splits on the
 * current platform separator, so a Windows path tested on macOS comes
 * back as the whole string. Split on both `/` and `\` and strip `.exe`.
 */
function shellBasename(shellPath: string): string {
  if (!shellPath) return ''
  const lastSlash = Math.max(shellPath.lastIndexOf('/'), shellPath.lastIndexOf('\\'))
  const tail = lastSlash >= 0 ? shellPath.slice(lastSlash + 1) : shellPath
  return tail.toLowerCase().replace(/\.exe$/, '')
}

/**
 * Conservative ConPTY-version gate. Win10 22H2 (build 19045+) and
 * Server 2022+ implement the OSC mark forwarding correctly; older
 * builds silently drop OSC. `os.release()` returns e.g. "10.0.19045"
 * on Win10 22H2.
 */
export function isConptyOscCapable(): boolean {
  if (process.platform !== 'win32') return true
  const rel = osRelease()
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(rel)
  if (!m) return false
  const major = parseInt(m[1]!, 10)
  const build = parseInt(m[3]!, 10)
  if (major < 10) return false
  return build >= 19045
}

/**
 * Build an integration plan for a given SpawnOptions. Does not mutate
 * its input; returns a new SpawnOptions with adjusted `args` and
 * `env`. The caller hands the returned `spawn` to node-pty.
 */
export function applyShellIntegration<T extends SpawnOptionsLike>(
  input: T,
  opts: ShellIntegrationOptions = {},
): ShellIntegrationPlan<T> {
  const kind = detectShellKind(input.shell)
  const envOptOut = (input.env.SHOGO_DISABLE_SHELL_INTEGRATION ?? '') === '1'
  // Until Phase 6 stabilises the shell-integration scripts end-to-end we
  // keep them OPT-IN: default to a plain shell so the terminal renders
  // a prompt and accepts input. Set SHOGO_ENABLE_SHELL_INTEGRATION=1 to
  // turn the OSC 633 marks back on for testing.
  const envOptIn = (input.env.SHOGO_ENABLE_SHELL_INTEGRATION ?? '') === '1'

  // ── status short-circuits ──────────────────────────────────────────
  if (opts.disabled) return passthrough(input, kind, 'disabled-by-option')
  if (envOptOut) return passthrough(input, kind, 'disabled-by-env')
  if (!envOptIn) return passthrough(input, kind, 'disabled-by-default')
  if (kind === 'unknown') {
    const name = shellBasename(input.shell)
    if (name === 'powershell') return passthrough(input, kind, 'windows-powershell-5')
    return passthrough(input, kind, 'unsupported-shell')
  }
  if (!isConptyOscCapable()) return passthrough(input, kind, 'conpty-too-old')

  // ── materialise temp files per shell ───────────────────────────────
  const tmpRoot = opts.tmpRoot ?? tmpdir()
  const root = mkdtempSync(join(tmpRoot, 'shogo-shell-'))
  const artifacts: string[] = [root]

  const baseEnv: Record<string, string> = {
    ...input.env,
    TERM_PROGRAM: 'shogo',
    SHOGO_TERMINAL: '1',
    SHOGO_SHELL_INTEGRATION: '1',
  }

  let nextArgs = input.args
  let nextEnv = baseEnv

  switch (kind) {
    case 'bash': {
      // Write a wrapper rcfile that sources the user's rc files first,
      // then our integration script.
      const intPath = join(root, 'shogo-bash-integration.sh')
      writeFileSync(intPath, BASH, 'utf8')
      const rcPath = join(root, 'shogo-bashrc')
      const userRc = [
        '# shogo wrapper rcfile',
        '[ -r ~/.bash_profile ] && . ~/.bash_profile',
        '[ -r ~/.bashrc ]       && . ~/.bashrc',
        `[ -r "${intPath}" ]    && . "${intPath}"`,
        '',
      ].join('\n')
      writeFileSync(rcPath, userRc, 'utf8')
      artifacts.push(intPath, rcPath)

      // We MUST invoke bash with --rcfile or POSIX-mode bash wouldn't
      // source it. Strip any prior --rcfile / --norc the caller passed
      // because they would override us.
      nextArgs = ['--rcfile', rcPath, ...stripArgs(input.args, ['--rcfile', '-rcfile'], 1), ...stripArgs(input.args, ['--norc'], 0)]
      // Recompute cleanly: remove --rcfile X and --norc from original args.
      nextArgs = sanitiseBashArgs(input.args, ['--rcfile', rcPath])
      break
    }
    case 'zsh': {
      // Lay down all 5 files in the temp ZDOTDIR; each one re-sources
      // the user's equivalent before our hooks run.
      writeFileSync(join(root, '.zshenv'),   ZSH_ENV,   'utf8')
      writeFileSync(join(root, '.zprofile'), ZSH_PROFILE, 'utf8')
      writeFileSync(join(root, '.zshrc'),    ZSH_RC,    'utf8')
      writeFileSync(join(root, '.zlogin'),   ZSH_LOGIN,   'utf8')
      writeFileSync(join(root, '.zlogout'),  ZSH_LOGOUT,  'utf8')
      artifacts.push(
        join(root, '.zshenv'),
        join(root, '.zprofile'),
        join(root, '.zshrc'),
        join(root, '.zlogin'),
        join(root, '.zlogout'),
      )
      nextEnv = {
        ...baseEnv,
        _SHOGO_ORIG_ZDOTDIR: input.env.ZDOTDIR ?? input.env.HOME ?? '',
        ZDOTDIR: root,
      }
      break
    }
    case 'fish': {
      // Put our integration script under conf.d of a temp XDG_CONFIG_HOME
      // that ALSO re-exports the user's config via fish's own conf.d
      // chain — fish reads BOTH the system + user configs unless we set
      // XDG_CONFIG_HOME, so we mirror the original location through.
      const xdg = join(root, 'xdg')
      const confd = join(xdg, 'fish', 'conf.d')
      mkdirSync(confd, { recursive: true })
      const intPath = join(confd, 'shogo-integration.fish')
      writeFileSync(intPath, FISH, 'utf8')
      artifacts.push(xdg, intPath)
      // If the user already had an XDG_CONFIG_HOME, we link their
      // fish dir into ours via fish_user_paths-style fallback: copy
      // their config.fish to load from the original location.
      const origXdg = input.env.XDG_CONFIG_HOME ?? join(input.env.HOME ?? '', '.config')
      const passthroughConf = join(confd, '00-shogo-passthrough.fish')
      writeFileSync(
        passthroughConf,
        `# Auto-generated by shogo: source the user's real fish config\n` +
          `if test -r "${origXdg}/fish/config.fish"\n` +
          `    source "${origXdg}/fish/config.fish"\n` +
          `end\n`,
        'utf8',
      )
      artifacts.push(passthroughConf)
      nextEnv = { ...baseEnv, XDG_CONFIG_HOME: xdg }
      break
    }
    case 'pwsh': {
      // pwsh -NoExit -Command "& '<profile>'"
      // The wrapper profile dot-sources the user's All-Users + Current-
      // User profiles first, then ours.
      const intPath = join(root, 'shogo-pwsh-integration.ps1')
      writeFileSync(intPath, PWSH, 'utf8')
      const wrapperPath = join(root, 'shogo-pwsh-profile.ps1')
      writeFileSync(
        wrapperPath,
        [
          '# shogo wrapper profile',
          '$ErrorActionPreference = "Continue"',
          'foreach ($p in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) {',
          '    if ($p -and (Test-Path -LiteralPath $p)) { . $p }',
          '}',
          `. "${intPath.replace(/\\/g, '\\\\')}"`,
          '',
        ].join('\n'),
        'utf8',
      )
      artifacts.push(intPath, wrapperPath)
      nextArgs = ['-NoExit', '-NoLogo', '-Command', `. '${wrapperPath.replace(/'/g, "''")}'`]
      break
    }
  }

  return {
    kind,
    status: 'applied',
    spawn: { ...input, args: nextArgs, env: nextEnv },
    artifacts,
    cleanup: () => cleanupArtifacts(artifacts),
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

function passthrough<T extends SpawnOptionsLike>(
  input: T,
  kind: ShellKind,
  status: ShellIntegrationStatus,
): ShellIntegrationPlan<T> {
  return {
    kind,
    status,
    spawn: input,
    artifacts: [],
    cleanup: () => undefined,
  }
}

function cleanupArtifacts(paths: string[]): void {
  // Remove the tmp root (first entry); rmSync recursive cleans everything inside.
  if (paths.length === 0) return
  const root = paths[0]!
  try {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  } catch {
    /* best-effort; don't crash the session on cleanup failure */
  }
}

/**
 * Remove an arg + (optionally) the following N values from an argv.
 * Used to strip a prior --rcfile <path> the caller passed before we
 * inject our own. Exported for unit tests.
 */
export function stripArgs(argv: string[], names: string[], followValues: number): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (names.includes(a)) {
      i += followValues
      continue
    }
    out.push(a)
  }
  return out
}

/**
 * bash-specific arg sanitiser: strips `--rcfile X`, `--norc`, and
 * `--noprofile`, then prepends our own `--rcfile <wrapperRc>`.
 */
export function sanitiseBashArgs(argv: string[], prepend: string[]): string[] {
  const stripped: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--rcfile') { i += 1; continue }
    if (a === '--norc' || a === '--noprofile') continue
    stripped.push(a)
  }
  return [...prepend, ...stripped]
}

