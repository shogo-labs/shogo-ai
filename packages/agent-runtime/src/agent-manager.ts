// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AgentManager — Dynamic Sub-Agent Registry and Lifecycle Manager
 *
 * Provides runtime registration of custom agent types, instance lifecycle
 * management (spawn, cancel, status), and per-type performance metrics.
 * Used by the "dynamic" subagentMode to let the main agent create and
 * manage its own specialist sub-agents.
 *
 * Also used by "static" mode for background task tracking.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import {
  runSubagent,
  getBuiltinSubagentConfig,
  type SubagentConfig,
  type SubagentResult,
  type SubagentStreamCallbacks,
} from './subagent'
import type { ToolContext } from './gateway-tools'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentTypeMetrics {
  totalRuns: number
  successes: number
  failures: number
  totalInputTokens: number
  totalOutputTokens: number
  totalWallTimeMs: number
  totalToolCalls: number
}

function emptyMetrics(): AgentTypeMetrics {
  return { totalRuns: 0, successes: 0, failures: 0, totalInputTokens: 0, totalOutputTokens: 0, totalWallTimeMs: 0, totalToolCalls: 0 }
}

interface RegisteredAgent {
  config: SubagentConfig
  createdAt: number
  persisted: boolean
  metrics: AgentTypeMetrics
}

export interface ManagedInstance {
  id: string
  type: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  completedAt?: number
  result?: SubagentResult
  promise: Promise<SubagentResult>
  abort: AbortController
  /** Conversation messages for resume support. */
  messages?: Message[]
}

export interface AgentTypeInfo {
  name: string
  description: string
  builtin: boolean
  metrics: AgentTypeMetrics
}

// ---------------------------------------------------------------------------
// Guardrail Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGENT_TYPES = 20
const DEFAULT_MAX_CONCURRENT_INSTANCES = 5
const DEFAULT_MAX_TOTAL_SPAWNS = 50
const DEFAULT_MAX_SYSTEM_PROMPT_LENGTH = 4000
const INSTANCE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

export class AgentManager {
  private registry = new Map<string, RegisteredAgent>()
  private instances = new Map<string, ManagedInstance>()
  private totalSpawns = 0

  private maxAgentTypes: number
  private maxConcurrentInstances: number
  private maxTotalSpawns: number
  private maxSystemPromptLength: number

  constructor(options?: {
    maxAgentTypes?: number
    maxConcurrentInstances?: number
    maxTotalSpawns?: number
    maxSystemPromptLength?: number
  }) {
    this.maxAgentTypes = options?.maxAgentTypes
      ?? (parseInt(process.env.MAX_AGENT_TYPES || '', 10) || DEFAULT_MAX_AGENT_TYPES)
    this.maxConcurrentInstances = options?.maxConcurrentInstances
      ?? (parseInt(process.env.MAX_AGENT_INSTANCES || '', 10) || DEFAULT_MAX_CONCURRENT_INSTANCES)
    this.maxTotalSpawns = options?.maxTotalSpawns
      ?? (parseInt(process.env.MAX_TOTAL_SPAWNS || '', 10) || DEFAULT_MAX_TOTAL_SPAWNS)
    this.maxSystemPromptLength = options?.maxSystemPromptLength ?? DEFAULT_MAX_SYSTEM_PROMPT_LENGTH
  }

  // -------------------------------------------------------------------------
  // Registry operations
  // -------------------------------------------------------------------------

  register(config: SubagentConfig, persist = false): { ok: true } | { ok: false; error: string } {
    if (config.systemPrompt.length > this.maxSystemPromptLength) {
      return { ok: false, error: `System prompt exceeds ${this.maxSystemPromptLength} char limit (got ${config.systemPrompt.length})` }
    }
    if (this.registry.size >= this.maxAgentTypes && !this.registry.has(config.name)) {
      return { ok: false, error: `Max agent types reached (${this.maxAgentTypes}). Unregister an existing type first.` }
    }

    const disallowed = new Set(['agent_create', 'agent_spawn', 'agent_status', 'agent_cancel', 'agent_result', 'agent_list', 'task'])
    if (config.toolNames) {
      const forbidden = config.toolNames.filter(t => disallowed.has(t))
      if (forbidden.length > 0) {
        return { ok: false, error: `Tools not allowed in sub-agents: ${forbidden.join(', ')}` }
      }
    }

    const existing = this.registry.get(config.name)
    this.registry.set(config.name, {
      config,
      createdAt: existing?.createdAt ?? Date.now(),
      persisted: persist,
      metrics: existing?.metrics ?? emptyMetrics(),
    })
    return { ok: true }
  }

  unregister(name: string): boolean {
    return this.registry.delete(name)
  }

  getConfig(name: string): SubagentConfig | null {
    return this.registry.get(name)?.config ?? null
  }

  listTypes(ctx?: ToolContext, allTools?: AgentTool[]): AgentTypeInfo[] {
    const builtinNames = ['explore', 'general-purpose', 'code_agent', 'canvas_agent']
    const result: AgentTypeInfo[] = []

    for (const bn of builtinNames) {
      const cfg = ctx && allTools ? getBuiltinSubagentConfig(bn, ctx, allTools) : null
      result.push({
        name: bn,
        description: cfg?.description ?? bn,
        builtin: true,
        metrics: this.registry.get(bn)?.metrics ?? emptyMetrics(),
      })
    }

    for (const [name, reg] of this.registry) {
      if (builtinNames.includes(name)) continue
      result.push({
        name,
        description: reg.config.description,
        builtin: false,
        metrics: reg.metrics,
      })
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------

  spawn(
    type: string,
    prompt: string,
    parentCtx: ToolContext,
    allTools: AgentTool[],
    callbacks?: SubagentStreamCallbacks,
    options?: { history?: Message[] },
  ): { ok: true; instanceId: string } | { ok: false; error: string } {
    if (this.totalSpawns >= this.maxTotalSpawns) {
      return { ok: false, error: `Max total spawns reached (${this.maxTotalSpawns}) for this session.` }
    }

    const running = [...this.instances.values()].filter(i => i.status === 'running').length
    if (running >= this.maxConcurrentInstances) {
      return { ok: false, error: `Max concurrent instances reached (${this.maxConcurrentInstances}). Wait for an agent to finish or cancel one.` }
    }

    let config = this.getConfig(type)
    if (!config) {
      config = getBuiltinSubagentConfig(type, parentCtx, allTools)
    }
    if (!config) {
      return { ok: false, error: `Unknown agent type: ${type}` }
    }

    const instanceId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const abortController = new AbortController()
    this.totalSpawns++

    const startTime = Date.now()
    const regEntry = this.registry.get(type)

    const promise = runSubagent(config, prompt, parentCtx, allTools, callbacks, { history: options?.history })
      .then((result) => {
        const inst = this.instances.get(instanceId)
        if (inst) {
          inst.status = 'completed'
          inst.completedAt = Date.now()
          inst.result = result
          inst.messages = result.newMessages
        }
        if (regEntry) {
          regEntry.metrics.totalRuns++
          regEntry.metrics.successes++
          regEntry.metrics.totalInputTokens += result.inputTokens
          regEntry.metrics.totalOutputTokens += result.outputTokens
          regEntry.metrics.totalToolCalls += result.toolCalls
          regEntry.metrics.totalWallTimeMs += Date.now() - startTime
        }
        this.cleanupStaleInstances()
        return result
      })
      .catch((err) => {
        const inst = this.instances.get(instanceId)
        if (inst) {
          inst.status = 'failed'
          inst.completedAt = Date.now()
          inst.result = { text: err.message, toolCalls: 0, iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
        if (regEntry) {
          regEntry.metrics.totalRuns++
          regEntry.metrics.failures++
          regEntry.metrics.totalWallTimeMs += Date.now() - startTime
        }
        this.cleanupStaleInstances()
        return inst!.result!
      })

    const instance: ManagedInstance = {
      id: instanceId,
      type,
      status: 'running',
      startedAt: startTime,
      promise,
      abort: abortController,
    }
    this.instances.set(instanceId, instance)

    return { ok: true, instanceId }
  }

  getInstance(id: string): ManagedInstance | null {
    return this.instances.get(id) ?? null
  }

  cancel(id: string): boolean {
    const inst = this.instances.get(id)
    if (!inst || inst.status !== 'running') return false
    inst.abort.abort()
    inst.status = 'cancelled'
    inst.completedAt = Date.now()
    return true
  }

  listInstances(): Array<{ id: string; type: string; status: string; startedAt: number; completedAt?: number }> {
    return [...this.instances.values()].map(i => ({
      id: i.id,
      type: i.type,
      status: i.status,
      startedAt: i.startedAt,
      completedAt: i.completedAt,
    }))
  }

  getInstanceMessages(id: string): Message[] | null {
    const inst = this.instances.get(id)
    return inst?.messages ?? null
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  persistToWorkspace(workspaceDir: string): void {
    const agentsDir = join(workspaceDir, '.claude', 'agents')
    for (const [, reg] of this.registry) {
      if (!reg.persisted) continue
      if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true })
      const filePath = join(agentsDir, `${reg.config.name}.md`)
      const frontmatter = [
        '---',
        `name: ${reg.config.name}`,
        `description: ${reg.config.description}`,
        ...(reg.config.toolNames ? [`tools: [${reg.config.toolNames.join(', ')}]`] : []),
        ...(reg.config.model ? [`model: ${reg.config.model}`] : []),
        ...(reg.config.maxTurns ? [`maxTurns: ${reg.config.maxTurns}`] : []),
        '---',
      ].join('\n')
      writeFileSync(filePath, `${frontmatter}\n${reg.config.systemPrompt}`, 'utf-8')
    }
  }

  saveMetrics(workspaceDir: string): void {
    const shogoDir = join(workspaceDir, '.shogo')
    if (!existsSync(shogoDir)) mkdirSync(shogoDir, { recursive: true })
    const metricsPath = join(shogoDir, 'agent-metrics.json')
    const data: Record<string, AgentTypeMetrics> = {}
    for (const [name, reg] of this.registry) {
      if (reg.metrics.totalRuns > 0) {
        data[name] = reg.metrics
      }
    }
    writeFileSync(metricsPath, JSON.stringify(data, null, 2), 'utf-8')
  }

  loadMetrics(workspaceDir: string): void {
    const metricsPath = join(workspaceDir, '.shogo', 'agent-metrics.json')
    if (!existsSync(metricsPath)) return
    try {
      const raw = readFileSync(metricsPath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, AgentTypeMetrics>
      for (const [name, metrics] of Object.entries(data)) {
        const reg = this.registry.get(name)
        if (reg) {
          reg.metrics = metrics
        }
      }
    } catch { /* non-fatal */ }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private cleanupStaleInstances(): void {
    const now = Date.now()
    for (const [id, inst] of this.instances) {
      if (inst.status !== 'running' && inst.completedAt && (now - inst.completedAt) > INSTANCE_TTL_MS) {
        this.instances.delete(id)
      }
    }
  }
}
