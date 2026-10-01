/**
 * Permission Engine — Local Agent Security Guardrails
 *
 * Central enforcement point for all agent tool permissions in local mode.
 * Wraps each tool's execute() via withPermissionGate() to intercept calls
 * before they run and evaluate them against the active security policy.
 *
 * Three tiers: strict (ask everything), balanced (allowlist-based), full_autonomy (YOLO).
 * Hard-blocked actions (sudo, rm -rf /, system paths) are denied in ALL modes.
 */

import { resolve, join, dirname } from 'path'
import { existsSync, lstatSync, statSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dedupeRoots, isWithinAnyRoot, isWithinRoot } from './path-boundary'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { createLogger } from '@shogo/shared-runtime'
import type {
  ActionRule,
  SecurityMode,
  SecurityPreference,
  PermissionCategory,
  PermissionCheckResult,
  PermissionRequest,
  PermissionResponse,
} from './types'

const log = createLogger('permission-engine')

// Re-export for convenience
export type { ActionRule, SecurityPreference, PermissionCategory, PermissionCheckResult }

// ---------------------------------------------------------------------------
// Hard-blocked patterns — enforced in ALL modes, never overridable
// ---------------------------------------------------------------------------

// Patterns checked against each sub-command after splitting on ; && ||
const SUB_COMMAND_BLOCKED: RegExp[] = [
  /^\s*sudo\s/,
  /^\s*rm\s+(-[a-z]*r[a-z]*\s+|--recursive\s+)\//,
  /^\s*shutdown\b/,
  /^\s*reboot\b/,
  /^\s*mkfs\b/,
  /^\s*dd\s+if=/,
  /^\s*chmod\s+777\b/,
  /^\s*kill\s+-9\s+1\b/,
  /^\s*format\s+[a-z]:/i,
]

// Patterns checked against the entire command string (cannot be split away)
const FULL_COMMAND_BLOCKED: RegExp[] = [
  /\|\s*(ba)?sh\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bsh\s+-c\b/,
  /\bbash\s+-c\b/,
  /\beval\s+["']/,
]

function isHardBlockedCommand(command: string): boolean {
  for (const pattern of FULL_COMMAND_BLOCKED) {
    if (pattern.test(command)) return true
  }
  const subCommands = command.split(/\s*(?:&&|\|\||;)\s*/)
  for (const sub of subCommands) {
    for (const pattern of SUB_COMMAND_BLOCKED) {
      if (pattern.test(sub)) return true
    }
  }
  return false
}

const HARD_BLOCKED_PATH_PREFIXES: string[] = [
  join(homedir(), '.ssh'),
  join(homedir(), '.gnupg'),
  join(homedir(), '.aws'),
  join(homedir(), '.config', 'gcloud'),
  join(homedir(), '.env'),
  join(homedir(), '.bashrc'),
  join(homedir(), '.zshrc'),
  join(homedir(), '.profile'),
  join(homedir(), 'Library', 'Keychains'),
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
]

// ---------------------------------------------------------------------------
// Default allowlists for Balanced mode
// ---------------------------------------------------------------------------

const DEFAULT_SHELL_ALLOWLIST: string[] = [
  'bun *', 'npm *', 'npx *', 'yarn *', 'pnpm *',
  'node *', 'deno *',
  'git status*', 'git log*', 'git diff*', 'git add *', 'git commit *',
  'git branch*', 'git checkout *', 'git stash*', 'git pull*', 'git fetch*',
  'git show*', 'git rev-parse*', 'git remote*',
  'ls *', 'ls', 'cat *', 'head *', 'tail *', 'wc *', 'grep *', 'find *', 'tree *',
  'echo *', 'printf *',
  'mkdir *', 'cp *', 'mv *', 'touch *',
  'tsc *', 'tsc', 'eslint *', 'prettier *', 'vitest *', 'jest *', 'pytest *',
  'curl -s *', 'curl --silent *', 'wget -q *',
  'which *', 'whoami', 'pwd', 'env', 'printenv *',
  'cd *', 'pushd *', 'popd',
]

/**
 * Extra Balanced-mode allowlist entries for Docker-class projects (see
 * `apps/metal-agent`'s VM class plumbing + `TechStackMeta.runtime.vmClass`).
 * `docker`/`docker compose` are not on the default allowlist because they
 * are meaningless (and the daemon is absent) on every other project class;
 * gating them behind `SHOGO_RUNTIME_CLASS=docker` — set by the API only
 * when it actually assigned a docker-class VM — avoids widening the
 * default surface for the vast majority of (non-Docker) projects.
 * `sudo` stays hard-blocked in every mode regardless (see
 * `SUB_COMMAND_BLOCKED` above): dockerd itself runs as root from `fc-init`,
 * the agent's own user only needs group membership, never `sudo`.
 */
const DOCKER_CLASS_SHELL_ALLOWLIST: string[] = [
  'docker *', 'docker',
  'docker-compose *',
  'make *', 'make',
]

/** True when this runtime was assigned a Docker-capable VM (Tier 2). */
function isDockerRuntimeClass(): boolean {
  return process.env.SHOGO_RUNTIME_CLASS === 'docker'
}

/** Balanced-mode base allowlist, widened with Docker commands on a docker-class runtime. */
function getDefaultShellAllowlist(): string[] {
  return isDockerRuntimeClass()
    ? [...DEFAULT_SHELL_ALLOWLIST, ...DOCKER_CLASS_SHELL_ALLOWLIST]
    : DEFAULT_SHELL_ALLOWLIST
}

const DEFAULT_NETWORK_ALLOWLIST: string[] = [
  'npmjs.org', 'registry.npmjs.org',
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'pypi.org', 'crates.io', 'pkg.go.dev',
  'stackoverflow.com',
]

// ---------------------------------------------------------------------------
// Glob-like pattern matching for allowlists
// ---------------------------------------------------------------------------

function matchesGlobPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true
  // "*.ext" from Always Allow (file extension) → value ends with .ext
  if (pattern.startsWith('*.')) {
    return value.endsWith(pattern.slice(1)) || value === pattern.slice(1)
  }
  // "*text*" → value contains text (e.g. "*gh pr merge*" catches it inside a longer command)
  if (pattern.length > 2 && pattern.startsWith('*') && pattern.endsWith('*')) {
    return value.includes(pattern.slice(1, -1))
  }
  if (pattern.endsWith(' *')) {
    return value.startsWith(pattern.slice(0, -1)) || value === pattern.slice(0, -2)
  }
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1))
  }
  return value === pattern
}

function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some(p => matchesGlobPattern(value, p))
}

function mergeUnique(a?: string[], b?: string[]): string[] {
  const set = new Set<string>([...(a ?? []), ...(b ?? [])])
  return [...set]
}

// ---------------------------------------------------------------------------
// Per-tool action rules
// ---------------------------------------------------------------------------

/**
 * Rules every agent has unless the project says otherwise. Merging a pull
 * request changes shared code, so it asks first.
 */
export const DEFAULT_ACTION_RULES: Readonly<Record<string, ActionRule>> = {
  github_merge_pr: 'ask',
}

const ACTION_RANK: Record<ActionRule, number> = { allow: 0, ask: 1, block: 2 }

export function isActionRule(value: unknown): value is ActionRule {
  return value === 'allow' || value === 'ask' || value === 'block'
}

/** Keep only well-formed `{ toolName: allow|ask|block }` entries. */
export function normalizeActionRules(value: unknown): Record<string, ActionRule> {
  const out: Record<string, ActionRule> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [tool, rule] of Object.entries(value as Record<string, unknown>)) {
    if (tool && isActionRule(rule)) out[tool] = rule
  }
  return out
}

/** Combine two rule sets; where both name a tool, the stricter rule wins. */
export function mergeActionRules(a?: Record<string, ActionRule>, b?: Record<string, ActionRule>): Record<string, ActionRule> {
  const out: Record<string, ActionRule> = { ...normalizeActionRules(a) }
  for (const [tool, rule] of Object.entries(normalizeActionRules(b))) {
    const existing = out[tool]
    out[tool] = existing && ACTION_RANK[existing] >= ACTION_RANK[rule] ? existing : rule
  }
  return out
}

// ---------------------------------------------------------------------------
// Policy merge with escalation protection
// ---------------------------------------------------------------------------

const TIER_RANK: Record<SecurityMode, number> = { strict: 0, balanced: 1, full_autonomy: 2 }

export function mergePolicy(
  userPref: SecurityPreference,
  projectOverride?: Partial<SecurityPreference>,
): SecurityPreference {
  if (!projectOverride) return userPref

  const effectiveMode: SecurityMode =
    TIER_RANK[projectOverride.mode ?? userPref.mode] <= TIER_RANK[userPref.mode]
      ? (projectOverride.mode ?? userPref.mode)
      : userPref.mode

  const userDeny = userPref.overrides?.shellCommands?.deny ?? []
  const projDeny = projectOverride.overrides?.shellCommands?.deny ?? []
  const userAllow = userPref.overrides?.shellCommands?.allow
  const projAllow = projectOverride.overrides?.shellCommands?.allow

  let mergedAllow: string[] | undefined
  if (userAllow && projAllow) {
    mergedAllow = userAllow.filter(a => projAllow.includes(a))
  } else {
    mergedAllow = userAllow ?? projAllow
  }

  return {
    mode: effectiveMode,
    overrides: {
      // A project can tighten a tool's rule but never loosen the user's.
      actions: mergeActionRules(userPref.overrides?.actions, projectOverride.overrides?.actions),
      shellCommands: {
        deny: [...new Set([...userDeny, ...projDeny])],
        allow: mergedAllow,
      },
      fileAccess: {
        deny: [
          ...(userPref.overrides?.fileAccess?.deny ?? []),
          ...(projectOverride.overrides?.fileAccess?.deny ?? []),
        ],
        allow: userPref.overrides?.fileAccess?.allow,
      },
      network: {
        allowedDomains: userPref.overrides?.network?.allowedDomains,
      },
      mcpTools: {
        autoApprove: userPref.overrides?.mcpTools?.autoApprove,
      },
    },
    approvalTimeoutSeconds: userPref.approvalTimeoutSeconds,
  }
}

// ---------------------------------------------------------------------------
// Default preference (used when nothing is configured)
// ---------------------------------------------------------------------------

export const DEFAULT_SECURITY_PREFERENCE: SecurityPreference = {
  mode: 'full_autonomy',
  approvalTimeoutSeconds: 30,
}

/** Cloud runtimes only ask about tools with an `ask` rule; people answer in a team channel, so give them time. */
export const DEFAULT_CLOUD_SECURITY_PREFERENCE: SecurityPreference = {
  mode: 'full_autonomy',
  approvalTimeoutSeconds: 900,
}

export function parseSecurityPolicy(envValue?: string, defaults: SecurityPreference = DEFAULT_SECURITY_PREFERENCE): SecurityPreference {
  if (!envValue) return defaults
  try {
    const decoded = Buffer.from(envValue, 'base64').toString('utf-8')
    return { ...defaults, ...JSON.parse(decoded) }
  } catch {
    console.warn('[PermissionEngine] Failed to parse SECURITY_POLICY env, using defaults')
    return defaults
  }
}

export function encodeSecurityPolicy(pref: SecurityPreference): string {
  return Buffer.from(JSON.stringify(pref)).toString('base64')
}

// ---------------------------------------------------------------------------
// PermissionEngine
// ---------------------------------------------------------------------------

export interface PermissionEngineOptions {
  preference: SecurityPreference
  workspaceDir: string
  /** Callback to push an SSE event to the connected UI client */
  sendSseEvent?: (event: Record<string, any>) => void
  /**
   * Enforce only per-tool action rules; everything else is allowed. For cloud
   * runtimes, which have never run the mode-based policy.
   */
  actionsOnly?: boolean
}

interface PendingApproval {
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
  cacheKey: string
  category: PermissionCategory
}

export class PermissionEngine {
  private pref: SecurityPreference
  private workspaceDir: string
  private sendSseEvent?: (event: Record<string, any>) => void
  private pendingApprovals = new Map<string, PendingApproval>()
  private sessionApprovalCache = new Map<string, boolean>()
  private denialCount = 0
  private readonly MAX_DENIALS_PER_TURN = 5
  private readonly persistPath: string
  private persistedMtimeMs = 0
  private readonly actionsOnly: boolean

  constructor(opts: PermissionEngineOptions) {
    this.actionsOnly = opts.actionsOnly === true
    this.pref = opts.preference
    this.workspaceDir = opts.workspaceDir
    this.sendSseEvent = opts.sendSseEvent
    this.persistPath = join(opts.workspaceDir, '.shogo', 'permissions.json')
    this.loadPersistedRules()
  }

  /**
   * Load persisted permission rules from .shogo/permissions.json and merge
   * them into the active preference. Called on construction so "Always Allow"
   * decisions survive across gateway restarts.
   */
  private loadPersistedRules(): void {
    try {
      if (!existsSync(this.persistPath)) return
      this.persistedMtimeMs = statSync(this.persistPath).mtimeMs
      const raw = readFileSync(this.persistPath, 'utf-8')
      const persisted = JSON.parse(raw) as Partial<SecurityPreference['overrides']>
      if (!persisted || typeof persisted !== 'object') return

      this.pref = {
        ...this.pref,
        overrides: {
          ...this.pref.overrides,
          actions: mergeActionRules(this.pref.overrides?.actions, persisted.actions),
          shellCommands: {
            allow: mergeUnique(
              this.pref.overrides?.shellCommands?.allow,
              persisted.shellCommands?.allow,
            ),
            deny: mergeUnique(
              this.pref.overrides?.shellCommands?.deny,
              persisted.shellCommands?.deny,
            ),
          },
          fileAccess: {
            allow: mergeUnique(
              this.pref.overrides?.fileAccess?.allow,
              persisted.fileAccess?.allow,
            ),
            deny: mergeUnique(
              this.pref.overrides?.fileAccess?.deny,
              persisted.fileAccess?.deny,
            ),
          },
          network: {
            allowedDomains: mergeUnique(
              this.pref.overrides?.network?.allowedDomains,
              persisted.network?.allowedDomains,
            ),
          },
          mcpTools: {
            autoApprove: mergeUnique(
              this.pref.overrides?.mcpTools?.autoApprove,
              persisted.mcpTools?.autoApprove,
            ),
          },
        },
      }
      log.info('Loaded persisted permission rules', { path: this.persistPath })
    } catch (err: any) {
      log.warn('Failed to load persisted permissions, starting fresh', { err: err.message })
    }
  }

  /**
   * Persist the current override rules to .shogo/permissions.json so they
   * survive across gateway restarts. Only the user-configured overrides are
   * persisted — the mode and hard-blocks are not included.
   */
  persistRules(): void {
    try {
      const dir = dirname(this.persistPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = JSON.stringify(this.pref.overrides ?? {}, null, 2)
      writeFileSync(this.persistPath, data, 'utf-8')
    } catch (err: any) {
      log.warn('Failed to persist permission rules', { err: err.message })
    }
  }

  /** Get the current overrides (for propagating to sub-agents). */
  getOverrides(): SecurityPreference['overrides'] | undefined {
    return this.pref.overrides
  }

  get mode(): SecurityMode {
    return this.pref.mode
  }

  /** True for cloud runtimes, where only per-tool action rules are enforced. */
  get isActionsOnly(): boolean {
    return this.actionsOnly
  }

  /** Wire (or re-wire) the SSE push callback at runtime */
  setSseCallback(cb: ((event: Record<string, any>) => void) | undefined): void {
    this.sendSseEvent = cb
  }

  /** Reset per-turn state (call at the start of each agent turn) */
  resetTurn(): void {
    // Rules a team writes into the workspace (e.g. a template's `.shogo/permissions.json`) apply on the next turn.
    try {
      if (existsSync(this.persistPath) && statSync(this.persistPath).mtimeMs !== this.persistedMtimeMs) this.loadPersistedRules()
    } catch { /* keep the rules already loaded */ }
    this.sessionApprovalCache.clear()
    this.denialCount = 0
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    this.pendingApprovals.clear()
  }

  /** Update the preference at runtime (e.g. when "Always Allow" adds a pattern) */
  updatePreference(pref: Partial<SecurityPreference>): void {
    this.pref = { ...this.pref, ...pref }
  }

  // -------------------------------------------------------------------------
  // Core policy evaluation
  // -------------------------------------------------------------------------

  /** The rule for a tool: the project's, else the built-in default, else none. */
  actionRuleFor(toolName: string): ActionRule | undefined {
    const configured = this.pref.overrides?.actions?.[toolName]
    if (isActionRule(configured)) return configured
    return DEFAULT_ACTION_RULES[toolName]
  }

  /** Result of a tool's action rule, or null when it has none (or `allow`). */
  checkAction(category: PermissionCategory, toolName: string): PermissionCheckResult | null {
    const rule = this.actionRuleFor(toolName)
    if (rule === 'block') {
      return {
        action: 'deny',
        reason: `"${toolName}" is set to never run for this agent`,
        guidance: 'A person configured this action as blocked. Tell the team it is not available and move on.',
        category,
      }
    }
    if (rule === 'ask') {
      return {
        action: 'ask',
        reason: `"${toolName}" needs a person's approval before it runs`,
        guidance: 'Waiting for someone on the team to approve.',
        category,
      }
    }
    return null
  }

  check(category: PermissionCategory, toolName: string, params: Record<string, any>): PermissionCheckResult {
    if (this.actionsOnly) {
      // Only what someone configured: deny lists and per-tool rules. No mode defaults, no built-in blocks.
      return this.checkDenyOverrides(category, toolName, params)
        ?? this.checkAction(category, toolName)
        ?? { action: 'allow', reason: 'No rule for this action', category }
    }

    // 1. Hard-block checks (always deny, all modes)
    const hardBlock = this.checkHardBlocked(category, toolName, params)
    if (hardBlock) return hardBlock

    // 2. User deny overrides
    const denyCheck = this.checkDenyOverrides(category, toolName, params)
    if (denyCheck) return denyCheck

    // 2b. Per-tool action rules
    const actionRule = this.actionRuleFor(toolName)
    if (actionRule) {
      return this.checkAction(category, toolName) ?? { action: 'allow', reason: `"${toolName}" is set to allow`, category }
    }

    // 3. Mode-specific evaluation
    switch (this.pref.mode) {
      case 'strict':
        return this.evaluateStrict(category, toolName, params)
      case 'balanced':
        return this.evaluateBalanced(category, toolName, params)
      case 'full_autonomy':
        return this.evaluateFullAutonomy(category, toolName, params)
    }
  }

  private checkHardBlocked(
    category: PermissionCategory,
    _toolName: string,
    params: Record<string, any>,
  ): PermissionCheckResult | null {
    if (category === 'shell') {
      const command = (params.command as string) || ''
      if (isHardBlockedCommand(command)) {
        return {
          action: 'deny',
          reason: `Blocked: this command matches a hard-blocked destructive pattern`,
          guidance: 'This command is never allowed. Ask the user to run it manually if needed.',
          category,
        }
      }
    }

    if (category === 'file_read' || category === 'file_write' || category === 'file_delete') {
      const filePath = (params.path as string) || ''
      const resolved = resolve(this.workspaceDir, filePath)
      for (const blocked of HARD_BLOCKED_PATH_PREFIXES) {
        if (resolved.startsWith(blocked) || resolved === blocked) {
          return {
            action: 'deny',
            reason: `Blocked: access to ${blocked} is never allowed`,
            guidance: 'System credential and config paths are protected. Work within the project directory.',
            category: 'system',
          }
        }
      }
    }

    if (category === 'system') {
      return {
        action: 'deny',
        reason: 'System-level actions are never allowed',
        category: 'system',
      }
    }

    return null
  }

  private checkDenyOverrides(
    category: PermissionCategory,
    _toolName: string,
    params: Record<string, any>,
  ): PermissionCheckResult | null {
    if (category === 'shell') {
      const command = (params.command as string) || ''
      const denyList = this.pref.overrides?.shellCommands?.deny ?? []
      if (matchesAnyPattern(command, denyList)) {
        return {
          action: 'deny',
          reason: 'This command matches a user-configured deny rule',
          guidance: 'The user has explicitly blocked this command pattern.',
          category,
        }
      }
    }

    if (category === 'file_read' || category === 'file_write' || category === 'file_delete') {
      const filePath = (params.path as string) || ''
      const denyList = this.pref.overrides?.fileAccess?.deny ?? []
      if (matchesAnyPattern(filePath, denyList)) {
        return {
          action: 'deny',
          reason: 'This path matches a user-configured deny rule',
          category,
        }
      }
    }

    return null
  }

  private evaluateStrict(
    category: PermissionCategory,
    _toolName: string,
    _params: Record<string, any>,
  ): PermissionCheckResult {
    if (category === 'file_read') {
      return { action: 'allow', reason: 'File reads allowed in strict mode (within workspace)', category }
    }
    const AGENT_CONFIG_FILES = ['AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json']
    const filePath = (_params.path as string) || ''
    if ((category === 'file_write' || category === 'file_delete') && AGENT_CONFIG_FILES.some(f => filePath.endsWith(f))) {
      return { action: 'allow', reason: 'Agent config files are always writable', category }
    }
    if ((category === 'file_write' || category === 'file_delete')) {
      const fileAllow = this.pref.overrides?.fileAccess?.allow ?? []
      if (matchesAnyPattern(filePath, fileAllow)) {
        return { action: 'allow', reason: 'File path on user allowlist', category }
      }
    }
    return {
      action: 'ask',
      reason: `Strict mode: approval required for ${category} actions`,
      guidance: 'In strict mode, every mutating action needs explicit user approval.',
      category,
    }
  }

  private evaluateBalanced(
    category: PermissionCategory,
    _toolName: string,
    params: Record<string, any>,
  ): PermissionCheckResult {
    switch (category) {
      case 'file_read':
        return { action: 'allow', reason: 'File reads auto-allowed in balanced mode', category }

      case 'file_write': {
        const fileAllow = this.pref.overrides?.fileAccess?.allow ?? []
        if (matchesAnyPattern((params.path as string) || '', fileAllow)) {
          return { action: 'allow', reason: 'File path on user allowlist (Always Allow)', category }
        }
        return this.checkWithinWorkspace(params)
          ? { action: 'allow', reason: 'File writes auto-allowed within project directory', category }
          : { action: 'ask', reason: 'File write outside project directory', category }
      }

      case 'file_delete': {
        const fileAllow = this.pref.overrides?.fileAccess?.allow ?? []
        if (matchesAnyPattern((params.path as string) || '', fileAllow)) {
          return { action: 'allow', reason: 'File path on user allowlist', category }
        }
        return { action: 'ask', reason: 'File deletes require approval in balanced mode', category }
      }

      case 'shell': {
        const command = (params.command as string) || ''
        const userAllow = this.pref.overrides?.shellCommands?.allow ?? []
        const combinedAllow = [...getDefaultShellAllowlist(), ...userAllow]
        if (matchesAnyPattern(command, combinedAllow)) {
          return { action: 'allow', reason: 'Command matches allowlist', category }
        }
        return {
          action: 'ask',
          reason: 'Command not on allowlist — approval required',
          guidance: 'You can ask the user to approve, or try a different approach.',
          category,
        }
      }

      case 'network': {
        const url = (params.url as string) || (params.query as string) || ''
        try {
          const hostname = new URL(url).hostname
          const userDomains = this.pref.overrides?.network?.allowedDomains ?? []
          const allDomains = [...DEFAULT_NETWORK_ALLOWLIST, ...userDomains]
          if (allDomains.some(d => hostname === d || hostname.endsWith(`.${d}`))) {
            return { action: 'allow', reason: 'Domain on allowlist', category }
          }
        } catch {
          // Not a URL (e.g. Serper query) — allow web searches
          if (!url.startsWith('http')) {
            return { action: 'allow', reason: 'Web search queries auto-allowed', category }
          }
        }
        return { action: 'ask', reason: 'Unknown domain — approval required', category }
      }

      case 'mcp': {
        const autoApprove = this.pref.overrides?.mcpTools?.autoApprove ?? []
        const toolName = (params.name as string) || ''
        if (autoApprove.includes(toolName)) {
          return { action: 'allow', reason: 'MCP tool on auto-approve list', category }
        }
        return { action: 'ask', reason: 'MCP tool install requires approval', category }
      }

      default:
        return { action: 'allow', reason: 'Allowed by default in balanced mode', category }
    }
  }

  private evaluateFullAutonomy(
    category: PermissionCategory,
    _toolName: string,
    _params: Record<string, any>,
  ): PermissionCheckResult {
    return { action: 'allow', reason: 'Full autonomy mode — all actions auto-allowed', category }
  }

  private checkWithinWorkspace(params: Record<string, any>): boolean {
    const filePath = (params.path as string) || ''
    try {
      const resolved = resolve(this.workspaceDir, filePath)
      if (!resolved.startsWith(this.workspaceDir)) return false
      if (existsSync(resolved)) {
        const real = realpathSync(resolved)
        if (!real.startsWith(this.workspaceDir)) return false
      }
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Approval request/response flow
  // -------------------------------------------------------------------------

  async requestApproval(
    toolCallId: string,
    toolName: string,
    category: PermissionCategory,
    params: Record<string, any>,
    reason: string,
  ): Promise<boolean> {
    // Check session cache first (e.g. "Allow Once" from earlier in this turn)
    const cacheKey = `${toolName}:${this.paramCacheKey(params)}`
    if (this.sessionApprovalCache.has(cacheKey)) {
      return this.sessionApprovalCache.get(cacheKey)!
    }

    // If too many denials, auto-deny without prompting
    if (this.denialCount >= this.MAX_DENIALS_PER_TURN) {
      log.warn('Too many denials in this turn, auto-denying', { toolName, denials: this.denialCount })
      return false
    }

    // If no SSE client connected, fail closed
    if (!this.sendSseEvent) {
      log.warn('No SSE callback available — cannot prompt user, denying', { toolName })
      return false
    }

    const DEFAULT_TIMEOUT_SECONDS = 30
    // An ask-first action rule is answered by a person in a chat thread, who may take a while.
    const configuredSeconds = this.pref.approvalTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const timeoutSeconds = this.actionRuleFor(toolName) === 'ask'
      ? Math.max(configuredSeconds, DEFAULT_CLOUD_SECURITY_PREFERENCE.approvalTimeoutSeconds ?? 0)
      : configuredSeconds
    const timeoutMs = timeoutSeconds * 1000
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const request: PermissionRequest = {
      id: requestId,
      toolName,
      category,
      params,
      reason,
      timeout: timeoutSeconds,
    }

    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        log.warn('Permission approval timed out', { requestId, toolName, timeoutMs })
        this.pendingApprovals.delete(requestId)
        this.denialCount++
        resolvePromise(false)
      }, timeoutMs)

      this.pendingApprovals.set(requestId, { resolve: resolvePromise, timer, cacheKey, category })

      try {
        this.sendSseEvent!({
          type: 'data-permission-request',
          data: request,
        })
      } catch (err) {
        log.error('Failed to send SSE permission request', { requestId, err })
        clearTimeout(timer)
        this.pendingApprovals.delete(requestId)
        resolvePromise(false)
      }
    })
  }

  /** Called when the frontend responds to a permission request */
  handleApprovalResponse(response: PermissionResponse): void {
    const pending = this.pendingApprovals.get(response.id)
    if (!pending) {
      log.warn('Received approval response for unknown request', { requestId: response.id })
      return
    }

    clearTimeout(pending.timer)
    this.pendingApprovals.delete(response.id)

    switch (response.decision) {
      case 'allow_once':
        this.sessionApprovalCache.set(pending.cacheKey, true)
        pending.resolve(true)
        break
      case 'always_allow':
        if (response.pattern) {
          const isFileCategory = pending.category === 'file_write' || pending.category === 'file_delete' || pending.category === 'file_read'
          if (isFileCategory) {
            const existing = this.pref.overrides?.fileAccess?.allow ?? []
            this.pref = {
              ...this.pref,
              overrides: {
                ...this.pref.overrides,
                fileAccess: {
                  ...this.pref.overrides?.fileAccess,
                  allow: [...existing, response.pattern],
                },
              },
            }
          } else {
            const existing = this.pref.overrides?.shellCommands?.allow ?? []
            this.pref = {
              ...this.pref,
              overrides: {
                ...this.pref.overrides,
                shellCommands: {
                  ...this.pref.overrides?.shellCommands,
                  allow: [...existing, response.pattern],
                },
              },
            }
          }
          this.persistRules()
        }
        this.sessionApprovalCache.set(pending.cacheKey, true)
        pending.resolve(true)
        break
      case 'deny':
        this.denialCount++
        this.sessionApprovalCache.set(pending.cacheKey, false)
        pending.resolve(false)
        break
    }
  }

  // -------------------------------------------------------------------------
  // (Audit logging removed — no disk I/O overhead)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private paramCacheKey(params: Record<string, any>): string {
    const command = params.command || params.path || params.name || params.url || ''
    return typeof command === 'string' ? command : JSON.stringify(command)
  }
}

// ---------------------------------------------------------------------------
// withPermissionGate — higher-order function to wrap any AgentTool
// ---------------------------------------------------------------------------

function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    details: data,
  }
}

const GATED = Symbol.for('shogo.permissionGated')

export function isPermissionGated(tool: AgentTool): boolean {
  return (tool as any)[GATED] === true
}

/**
 * Gate a tool that has no category of its own: only its per-tool action rule
 * applies (run, ask first, or refuse). Tools already gated are left alone.
 */
export function withActionRules(tool: AgentTool, engine: PermissionEngine): AgentTool {
  if (isPermissionGated(tool)) return tool
  return gate(tool, engine, (toolName) => engine.checkAction('project', toolName))
}

export function withPermissionGate(
  tool: AgentTool,
  category: PermissionCategory,
  engine: PermissionEngine,
): AgentTool {
  return gate(tool, engine, (toolName, params) => engine.check(category, toolName, params), category)
}

function gate(
  tool: AgentTool,
  engine: PermissionEngine,
  evaluate: (toolName: string, params: Record<string, any>) => PermissionCheckResult | null,
  category: PermissionCategory = 'project',
): AgentTool {
  const originalExecute = tool.execute
  const gated: AgentTool = {
    ...tool,
    execute: async (toolCallId: string, params: any) => {
      const check = evaluate(tool.name, params ?? {})
      if (!check) return originalExecute(toolCallId, params)

      if (check.action === 'deny') {
        return textResult({
          error: `Permission denied: ${check.reason}`,
          instruction: 'This action is permanently blocked by the security system. Do NOT ask the user to approve it in chat. Inform the user this action is not available and move on.',
        })
      }

      if (check.action === 'ask') {
        const approved = await engine.requestApproval(
          toolCallId,
          tool.name,
          category,
          params ?? {},
          check.reason,
        )
        if (!approved) {
          return textResult({
            error: 'The user was asked via the security approval dialog and declined this action.',
            instruction: 'Do NOT ask the user again or request confirmation in chat. The user already made their decision through the permission dialog. Acknowledge the denial briefly and continue.',
          })
        }
      }

      return originalExecute(toolCallId, params)
    },
  }
  ;(gated as any)[GATED] = true
  return gated
}

// ---------------------------------------------------------------------------
// Path validation (replaces old assertWithinWorkspace)
// ---------------------------------------------------------------------------

export function assertWithinWorkspace(workspaceDir: string, filePath: string): string {
  const resolved = resolve(workspaceDir, filePath)

  // External (VS Code-style) projects: validate against the union of
  // [WORKSPACE_DIR, ...linkedFolders]. We import lazily so tests that
  // pull in `assertWithinWorkspace` directly don't drag the runtime
  // config global onto themselves.
  const linkedFoldersRaw = process.env.LINKED_FOLDERS
  if (linkedFoldersRaw) {
    let linkedFolders: string[] = []
    try {
      const parsed = JSON.parse(linkedFoldersRaw)
      if (Array.isArray(parsed)) {
        linkedFolders = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
      }
    } catch {
      /* fall through */
    }
    const roots = dedupeRoots([workspaceDir, ...linkedFolders].map((r) => resolve(r)))
    const realRoots = dedupeRoots(
      roots.map((r) => {
        try {
          return realpathSync(r)
        } catch {
          return r
        }
      }),
    )
    const ok = isWithinAnyRoot(realRoots, resolved)
    if (!ok) {
      throw new Error(
        `Path is outside the project's allowed folders: ${filePath}\n` +
          `Allowed roots:\n  - ${roots.join('\n  - ')}`,
      )
    }
    // Symlink-escape defense for files that already exist.
    if (existsSync(resolved)) {
      let real: string
      try {
        real = realpathSync(resolved)
      } catch {
        return resolved
      }
      const realOk = isWithinAnyRoot(realRoots, real)
      if (!realOk) {
        throw new Error(`Symlink target outside allowed roots: ${filePath}`)
      }
    }
    return resolved
  }

  if (process.env.SHOGO_LOCAL_MODE === 'true') return resolved
  if (!isWithinRoot(workspaceDir, resolved)) {
    throw new Error(`Path outside workspace: ${filePath}`)
  }
  if (existsSync(resolved)) {
    const realWorkspace = realpathSync(workspaceDir)
    const real = realpathSync(resolved)
    if (!isWithinRoot(realWorkspace, real) && !isWithinRoot(workspaceDir, real)) {
      throw new Error(`Symlink target outside workspace: ${filePath}`)
    }
  }
  return resolved
}
