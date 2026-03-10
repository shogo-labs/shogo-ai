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

import { resolve, join } from 'path'
import { existsSync, lstatSync, realpathSync } from 'fs'
import { homedir } from 'os'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type {
  SecurityMode,
  SecurityPreference,
  PermissionCategory,
  PermissionCheckResult,
  PermissionRequest,
  PermissionResponse,
} from './types'

// Re-export for convenience
export type { SecurityPreference, PermissionCategory, PermissionCheckResult }

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
  mode: 'balanced',
  approvalTimeoutSeconds: 60,
}

export function parseSecurityPolicy(envValue?: string): SecurityPreference {
  if (!envValue) return DEFAULT_SECURITY_PREFERENCE
  try {
    const decoded = Buffer.from(envValue, 'base64').toString('utf-8')
    return { ...DEFAULT_SECURITY_PREFERENCE, ...JSON.parse(decoded) }
  } catch {
    console.warn('[PermissionEngine] Failed to parse SECURITY_POLICY env, using defaults')
    return DEFAULT_SECURITY_PREFERENCE
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

  constructor(opts: PermissionEngineOptions) {
    this.pref = opts.preference
    this.workspaceDir = opts.workspaceDir
    this.sendSseEvent = opts.sendSseEvent
  }

  get mode(): SecurityMode {
    return this.pref.mode
  }

  /** Wire (or re-wire) the SSE push callback at runtime */
  setSseCallback(cb: ((event: Record<string, any>) => void) | undefined): void {
    this.sendSseEvent = cb
  }

  /** Reset per-turn state (call at the start of each agent turn) */
  resetTurn(): void {
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

  check(category: PermissionCategory, toolName: string, params: Record<string, any>): PermissionCheckResult {
    // 1. Hard-block checks (always deny, all modes)
    const hardBlock = this.checkHardBlocked(category, toolName, params)
    if (hardBlock) return hardBlock

    // 2. User deny overrides
    const denyCheck = this.checkDenyOverrides(category, toolName, params)
    if (denyCheck) return denyCheck

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
    if ((category === 'file_write' || category === 'file_delete') && isAgentConfigFile((params.path as string) || '')) {
      return { action: 'allow', reason: 'Agent config files are always writable', category }
    }
    if ((category === 'file_write' || category === 'file_delete')) {
      const fileAllow = this.pref.overrides?.fileAccess?.allow ?? []
      if (matchesAnyPattern((params.path as string) || '', fileAllow)) {
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

      case 'file_write':
        return this.checkWithinWorkspace(params)
          ? { action: 'allow', reason: 'File writes auto-allowed within project directory', category }
          : { action: 'ask', reason: 'File write outside project directory', category }

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
        const combinedAllow = [...DEFAULT_SHELL_ALLOWLIST, ...userAllow]
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
      return false
    }

    // If no SSE client connected, fail closed
    if (!this.sendSseEvent) {
      return false
    }

    const timeout = (this.pref.approvalTimeoutSeconds ?? 60) * 1000
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const request: PermissionRequest = {
      id: requestId,
      toolName,
      category,
      params,
      reason,
      timeout: this.pref.approvalTimeoutSeconds ?? 60,
    }

    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId)
        this.denialCount++
        resolvePromise(false)
      }, timeout)

      this.pendingApprovals.set(requestId, { resolve: resolvePromise, timer, cacheKey, category })

      this.sendSseEvent!({
        type: 'data-permission-request',
        data: request,
      })
    })
  }

  /** Called when the frontend responds to a permission request */
  handleApprovalResponse(response: PermissionResponse): void {
    const pending = this.pendingApprovals.get(response.id)
    if (!pending) return

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

export function withPermissionGate(
  tool: AgentTool,
  category: PermissionCategory,
  engine: PermissionEngine,
): AgentTool {
  const originalExecute = tool.execute
  return {
    ...tool,
    execute: async (toolCallId: string, params: any) => {
      const check = engine.check(category, tool.name, params ?? {})

      if (check.action === 'deny') {
        return textResult({
          error: `Permission denied: ${check.reason}`,
          ...(check.guidance ? { guidance: check.guidance } : {}),
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
            error: `Action not approved by user. ${check.guidance || 'Try asking the user what they would like you to do instead.'}`,
          })
        }
      }

      return originalExecute(toolCallId, params)
    },
  }
}

// ---------------------------------------------------------------------------
// Path validation (replaces old assertWithinWorkspace)
// ---------------------------------------------------------------------------

export function assertWithinWorkspace(workspaceDir: string, filePath: string): string {
  const resolved = resolve(workspaceDir, filePath)
  if (!resolved.startsWith(workspaceDir)) {
    throw new Error(`Path outside workspace: ${filePath}`)
  }
  if (existsSync(resolved)) {
    const real = realpathSync(resolved)
    if (!real.startsWith(workspaceDir)) {
      throw new Error(`Symlink target outside workspace: ${filePath}`)
    }
  }
  return resolved
}
