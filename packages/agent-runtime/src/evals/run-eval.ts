#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Eval Runner
 *
 * Spins up real agent-runtime instances and runs evals against them.
 * By default uses Docker containers; pass --local to spawn local bun processes,
 * or --vm to use VM isolation (macOS Virtualization.framework / Windows QEMU).
 *
 * Usage:
 *   bun run src/evals/run-eval.ts --track canvas --model haiku
 *   bun run src/evals/run-eval.ts --track canvas --model haiku --local
 *   bun run src/evals/run-eval.ts --track canvas --model haiku --vm
 *   bun run src/evals/run-eval.ts --track all --model sonnet --workers 2
 *   bun run src/evals/run-eval.ts --track canvas --filter weather
 *   bun run src/evals/run-eval.ts --track skill-server-advanced --save-workspaces
 *   bun run src/evals/run-eval.ts --track canvas --model haiku --build
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, cpSync, lstatSync, statSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { tmpdir } from 'os'

import {
  type DockerWorker,
  type DockerWorkerConfig,
  evalWorkerConfig,
  loadEnvFromDisk,
  getArg,
  MODEL_MAP,
  PRICING,
  REPO_ROOT,
  DEFAULT_RUNTIME_IMAGE,
  writeDockerEnvFile,
  cleanupDockerEnvFile,
  ensureDockerImage,
  startDockerWorker,
  stopDockerWorker,
  isWorkerHealthy,
  configureWorkerForTask,
  registerCleanupHandlers,
} from './docker-worker'
import { type LocalWorkerConfig, startLocalWorker, stopLocalWorker } from './local-worker'
import { type VMWorkerConfig, startVMWorker, stopVMWorker } from './vm-worker'
import { type K8sWorkerConfig, startK8sWorker, stopK8sWorkerSync, stopK8sWorker, getK8sWorkerUrl } from './k8s-worker'

loadEnvFromDisk(REPO_ROOT)

import { runEval } from './runner'
import { calculateDollarCost } from '@shogo/model-catalog'
import { resetWorkspaceDefaults, seedLSPConfig, seedRuntimeTemplate, seedSkillServer } from '../workspace-defaults'
import { COMPLEX_EVALS } from './test-cases-complex'
import { MEMORY_EVALS } from './test-cases-memory'
import { PERSONALITY_EVALS } from './test-cases-personality'
import { MULTITURN_EVALS } from './test-cases-multiturn'
import { MCP_DISCOVERY_EVALS } from './test-cases-mcp-discovery'
import { MCP_ORCHESTRATION_EVALS } from './test-cases-mcp-orchestration'
import { MCP_VACATION_PLANNER_EVALS } from './test-cases-mcp-vacation-planner'
import { COMPOSIO_EVALS } from './test-cases-composio'
import { TOOL_SYSTEM_EVALS } from './test-cases-tool-system'
import { FILE_UPLOAD_EVALS } from './test-cases-file-upload'
import { REAL_DATA_EVALS } from './test-cases-real-data'
import { TRIP_PLANNER_EVALS } from './test-cases-trip-planner'
import { TEMPLATE_EVALS } from './test-cases-template'
import { DATA_PROCESSING_EVALS } from './test-cases-data-processing'
import { CODE_AGENT_EVALS } from './test-cases-code-agent'
import { CODE_AGENT_V2_EVALS } from './test-cases-code-agent-v2'
import { CANVAS_V2_EVALS } from './test-cases-canvas-v2'
import { CLI_ROUTING_EVALS } from './test-cases-cli-routing'
import { SKILL_SYSTEM_EVALS } from './test-cases-skill-system'
import { SKILL_SERVER_EVALS } from './test-cases-skill-server'
import { SKILL_SERVER_TEMPLATE_EVALS } from './test-cases-skill-server-templates'
import { EDIT_FILE_EVALS } from './test-cases-edit-file'
import { CHANNEL_CONNECT_EVALS } from './test-cases-channel-connect'
import { CANVAS_V2_LINT_EVALS } from './test-cases-canvas-v2-lint'
import { WORKSPACE_PARITY_EVALS } from './test-cases-workspace-parity'
import { BUG_FIX_EVALS } from './test-cases-bug-fix'
import { CODING_DISCIPLINE_EVALS } from './test-cases-coding-discipline'
import { SKILL_SERVER_ADVANCED_EVALS } from './test-cases-skill-server-advanced'
import { SUBAGENT_CODE_EVALS } from './test-cases-subagent-code'
import { SUBAGENT_AB_EVALS } from './test-cases-subagent-ab'
import { subagentEvals as SUBAGENT_EVALS } from './test-cases-subagent'
import { BUSINESS_USER_EVALS } from './test-cases-business-user'
import { STARTUP_CTO_EVALS } from './test-cases-startup-cto'
import { FREELANCER_EVALS } from './test-cases-freelancer'
import { CONTENT_CREATOR_EVALS } from './test-cases-content-creator'
import { NONPROFIT_EVALS } from './test-cases-nonprofit'
import { EVENT_PLANNER_EVALS } from './test-cases-event-planner'
import { ADVERSARIAL_EVALS } from './test-cases-adversarial'
import { CROSS_CUTTING_EVALS } from './test-cases-cross-cutting'
import { SUBAGENT_COORDINATION_EVALS } from './test-cases-subagent-coordination'
import { TEAMMATE_COORDINATION_EVALS } from './test-cases-teammate-coordination'
import { KNOWLEDGE_GRAPH_EVALS } from './test-cases-knowledge-graph'
import { TOKEN_BUDGET_EVALS } from './test-cases-token-budget'
import { PLAN_EVALS } from './test-cases-plans'
import { buildMockPayload } from './tool-mocks'
import type { AgentEval, EvalResult, EvalSuiteResult, CategorySummary, ResourceSummary, RuntimeCheckResults } from './types'
import { runRuntimeChecks } from './runtime-checks'
import { DockerStatsCollector, formatMillicores } from './docker-stats-collector'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const trackArg = getArg(args, 'track', 'all')!
const modelArg = getArg(args, 'model', 'haiku')!
const workersArg = parseInt(getArg(args, 'workers', '1')!)
const filterArg = getArg(args, 'filter')
const tagsArg = getArg(args, 'tags')
const agentModeArg = getArg(args, 'agent-mode') as 'basic' | 'advanced' | 'auto' | undefined
const promptProfileArg = getArg(args, 'prompt-profile') as 'full' | 'swe' | 'general' | undefined
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')
const localFlag = args.includes('--local')
const vmFlag = args.includes('--vm')
const k8sFlag = args.includes('--k8s') || (!localFlag && !vmFlag && !args.includes('--docker') && !!process.env.KUBERNETES_SERVICE_HOST)
const mountFlag = args.includes('--mount')
const saveWorkspacesFlag = args.includes('--save-workspaces')
const noPipelineFlag = args.includes('--no-pipeline')
const runIdArg = getArg(args, 'run-id')
const callbackUrlArg = getArg(args, 'callback-url')
const callbackSecret = process.env.EVAL_CALLBACK_SECRET || 'dev-eval-secret'

const useCallback = !!(runIdArg && callbackUrlArg)

async function postCallback(path: string, body: any, timeoutMs = 30_000): Promise<void> {
  if (!useCallback) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${callbackUrlArg}/api/internal${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${callbackSecret}`,
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function postCallbackSafe(path: string, body: any, timeoutMs = 30_000): Promise<void> {
  try {
    await postCallback(path, body, timeoutMs)
  } catch (err: any) {
    console.warn(`[callback] Failed to POST ${path}: ${err.message}`)
  }
}

const BASE_PORT = 6400
const SKILL_SERVER_BASE_PORT = 4100
const CONTAINER_SKILL_PORT = 4100

function getWorkerBaseUrl(worker: DockerWorker): string {
  if (k8sFlag) return getK8sWorkerUrl(worker)
  return `http://localhost:${worker.port}`
}

function getEvals(track: string): AgentEval[] {
  switch (track) {
    case 'canvas': return CANVAS_V2_EVALS
    case 'complex': return COMPLEX_EVALS
    case 'memory': return MEMORY_EVALS
    case 'personality': return PERSONALITY_EVALS
    case 'multiturn': return MULTITURN_EVALS
    case 'mcp-discovery': return MCP_DISCOVERY_EVALS
    case 'mcp-orchestration': return MCP_ORCHESTRATION_EVALS
    case 'vacation-planner': return MCP_VACATION_PLANNER_EVALS
    case 'composio': return COMPOSIO_EVALS
    case 'tool-system': return TOOL_SYSTEM_EVALS
    case 'file-upload': return FILE_UPLOAD_EVALS
    case 'real-data': return REAL_DATA_EVALS
    case 'trip-planner': return TRIP_PLANNER_EVALS
    case 'template': return TEMPLATE_EVALS
    case 'data-processing': return DATA_PROCESSING_EVALS
    case 'code-agent': return CODE_AGENT_EVALS
    case 'code-agent-v2': return CODE_AGENT_V2_EVALS
    case 'canvas-v2': return CANVAS_V2_EVALS
    case 'canvas-v2-lint': return CANVAS_V2_LINT_EVALS
    case 'workspace-parity': return WORKSPACE_PARITY_EVALS
    case 'cli-routing': return CLI_ROUTING_EVALS
    case 'skill-system': return SKILL_SYSTEM_EVALS
    case 'skill-server': return SKILL_SERVER_EVALS
    case 'skill-server-templates': return SKILL_SERVER_TEMPLATE_EVALS
    case 'edit-file': return EDIT_FILE_EVALS
    case 'channel-connect': return CHANNEL_CONNECT_EVALS
    case 'bug-fix': return BUG_FIX_EVALS
    case 'coding-discipline': return CODING_DISCIPLINE_EVALS
    case 'skill-server-advanced': return SKILL_SERVER_ADVANCED_EVALS
    case 'subagent': return SUBAGENT_EVALS
    case 'subagent-code': return SUBAGENT_CODE_EVALS
    case 'subagent-ab': return SUBAGENT_AB_EVALS
    case 'business-user': return BUSINESS_USER_EVALS
    case 'startup-cto': return STARTUP_CTO_EVALS
    case 'freelancer': return FREELANCER_EVALS
    case 'content-creator': return CONTENT_CREATOR_EVALS
    case 'event-planner': return EVENT_PLANNER_EVALS
    case 'nonprofit': return NONPROFIT_EVALS
    case 'adversarial': return ADVERSARIAL_EVALS
    case 'cross-cutting': return CROSS_CUTTING_EVALS
    case 'subagent-coordination': return SUBAGENT_COORDINATION_EVALS
    case 'teammate-coordination': return TEAMMATE_COORDINATION_EVALS
    case 'knowledge-graph': return KNOWLEDGE_GRAPH_EVALS
    case 'token-budget': return TOKEN_BUDGET_EVALS
    case 'plan': return PLAN_EVALS
    case 'persona': return [...BUSINESS_USER_EVALS, ...STARTUP_CTO_EVALS, ...FREELANCER_EVALS, ...CONTENT_CREATOR_EVALS, ...NONPROFIT_EVALS, ...EVENT_PLANNER_EVALS, ...ADVERSARIAL_EVALS, ...CROSS_CUTTING_EVALS]
    case 'agentic': return [...BUSINESS_USER_EVALS, ...STARTUP_CTO_EVALS, ...FREELANCER_EVALS, ...CONTENT_CREATOR_EVALS, ...NONPROFIT_EVALS, ...EVENT_PLANNER_EVALS, ...ADVERSARIAL_EVALS, ...CROSS_CUTTING_EVALS, ...SUBAGENT_COORDINATION_EVALS, ...TEAMMATE_COORDINATION_EVALS]
    case 'all': return [...CANVAS_V2_EVALS, ...CANVAS_V2_LINT_EVALS, ...WORKSPACE_PARITY_EVALS, ...COMPLEX_EVALS, ...MEMORY_EVALS, ...PERSONALITY_EVALS, ...MULTITURN_EVALS, ...MCP_DISCOVERY_EVALS, ...MCP_ORCHESTRATION_EVALS, ...MCP_VACATION_PLANNER_EVALS, ...COMPOSIO_EVALS, ...TOOL_SYSTEM_EVALS, ...FILE_UPLOAD_EVALS, ...REAL_DATA_EVALS, ...TRIP_PLANNER_EVALS, ...TEMPLATE_EVALS, ...DATA_PROCESSING_EVALS, ...CLI_ROUTING_EVALS, ...SKILL_SYSTEM_EVALS, ...SKILL_SERVER_EVALS, ...SKILL_SERVER_TEMPLATE_EVALS, ...SKILL_SERVER_ADVANCED_EVALS, ...EDIT_FILE_EVALS, ...CHANNEL_CONNECT_EVALS, ...BUG_FIX_EVALS, ...CODING_DISCIPLINE_EVALS, ...SUBAGENT_EVALS, ...SUBAGENT_CODE_EVALS, ...SUBAGENT_AB_EVALS, ...SUBAGENT_COORDINATION_EVALS, ...TEAMMATE_COORDINATION_EVALS, ...KNOWLEDGE_GRAPH_EVALS, ...TOKEN_BUDGET_EVALS, ...PLAN_EVALS, ...BUSINESS_USER_EVALS, ...STARTUP_CTO_EVALS, ...FREELANCER_EVALS, ...CONTENT_CREATOR_EVALS, ...NONPROFIT_EVALS, ...EVENT_PLANNER_EVALS, ...ADVERSARIAL_EVALS, ...CROSS_CUTTING_EVALS]
    default:
      console.error(`Unknown track: ${track}. Valid: canvas, canvas-v2, canvas-v2-lint, workspace-parity, complex, memory, personality, multiturn, mcp-discovery, mcp-orchestration, vacation-planner, composio, tool-system, file-upload, real-data, trip-planner, template, data-processing, code-agent, code-agent-v2, cli-routing, skill-system, skill-server, skill-server-templates, skill-server-advanced, edit-file, channel-connect, bug-fix, coding-discipline, subagent, subagent-code, subagent-ab, subagent-coordination, teammate-coordination, knowledge-graph, token-budget, plan, business-user, startup-cto, freelancer, content-creator, event-planner, nonprofit, adversarial, cross-cutting, persona, agentic, all`)
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Pipeline work-queue
// ---------------------------------------------------------------------------

type WorkItem =
  | { type: 'standalone'; eval: AgentEval }
  | { type: 'pipeline'; name: string; phases: AgentEval[] }

function buildWorkQueue(evals: AgentEval[]): WorkItem[] {
  if (noPipelineFlag) {
    return evals.map(ev => ({ type: 'standalone', eval: ev }))
  }

  const pipelineMap = new Map<string, AgentEval[]>()
  const standalone: AgentEval[] = []

  for (const ev of evals) {
    if (ev.pipeline) {
      const arr = pipelineMap.get(ev.pipeline) || []
      arr.push(ev)
      pipelineMap.set(ev.pipeline, arr)
    } else {
      standalone.push(ev)
    }
  }

  const items: WorkItem[] = []

  for (const [name, phases] of pipelineMap) {
    phases.sort((a, b) => (a.pipelinePhase ?? 0) - (b.pipelinePhase ?? 0))
    items.push({ type: 'pipeline', name, phases })
  }

  for (const ev of standalone) {
    items.push({ type: 'standalone', eval: ev })
  }

  return items
}

// ---------------------------------------------------------------------------
// Workspace archiving (template-compatible format)
// ---------------------------------------------------------------------------

const EVAL_OUTPUTS_DIR = resolve(REPO_ROOT, 'packages/agent-runtime/eval-outputs')

function writeEvalLog(
  result: EvalResult,
  runDir: string,
): string {
  const ev = result.eval
  const logDir = join(runDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${ev.id}.md`)

  const status = result.passed ? 'PASS' : 'FAIL'
  const lines: string[] = []

  lines.push(`# ${status}: ${ev.name}`)
  lines.push('')

  // Surface runtime failures prominently at the top
  const rc = result.runtimeChecks
  const hasRuntimeFailure = rc && (
    rc.serverHealthy === false ||
    !rc.canListModels ||
    !rc.canCreateRecord ||
    rc.canvasCompiles === false ||
    rc.missingRoutes.length > 0 ||
    (rc.workspaceIntegrity && (!rc.workspaceIntegrity.schema || !rc.workspaceIntegrity.server || !rc.workspaceIntegrity.prismaClient))
  )
  if (hasRuntimeFailure) {
    lines.push('> **RUNTIME FAILURES DETECTED** — The generated application is not fully functional.')
    lines.push('>')
    if (rc.serverHealthy === false) lines.push('> - Server health check FAILED')
    if (!rc.canListModels) lines.push('> - Cannot list models via API (routes returning errors)')
    if (!rc.canCreateRecord) lines.push('> - Cannot create records via API')
    if (rc.missingRoutes.length > 0) lines.push(`> - Missing routes for: ${rc.missingRoutes.join(', ')}`)
    if (rc.canvasCompiles === false) lines.push(`> - Canvas compilation failed (${rc.canvasCompileErrors.length} errors)`)
    if (rc.workspaceIntegrity) {
      const wi = rc.workspaceIntegrity
      const missing: string[] = []
      if (!wi.schema) missing.push('schema.prisma')
      if (!wi.server) missing.push('server.ts')
      if (!wi.db) missing.push('db.ts')
      if (!wi.prismaClient) missing.push('@prisma/client')
      if (!wi.generated) missing.push('generated/')
      if (missing.length > 0) lines.push(`> - Missing workspace files: ${missing.join(', ')}`)
    }
    if (rc.canvasOrphanedFetches.length > 0) lines.push(`> - Canvas fetches non-existent routes: ${rc.canvasOrphanedFetches.join(', ')}`)
    if (rc.errors.length > 0) {
      lines.push('>')
      for (const e of rc.errors.slice(0, 5)) lines.push(`> - ${e}`)
      if (rc.errors.length > 5) lines.push(`> - ...and ${rc.errors.length - 5} more`)
    }
    lines.push('')
  }

  lines.push('## Metadata')
  lines.push(`| Field | Value |`)
  lines.push(`|-------|-------|`)
  lines.push(`| ID | \`${ev.id}\` |`)
  lines.push(`| Category | ${ev.category} |`)
  lines.push(`| Level | ${ev.level} |`)
  lines.push(`| Score | **${result.score}/${result.maxScore}** (${result.percentage.toFixed(1)}%) |`)
  lines.push(`| Duration | ${(result.timing.durationMs / 1000).toFixed(1)}s |`)
  lines.push(`| Tool Calls | ${result.metrics.toolCallCount} (${result.metrics.failedToolCalls} failed) |`)
  const t = result.metrics.tokens
  const totalIn = t.input + t.cacheRead + t.cacheWrite
  lines.push(`| Tokens (in) | ${totalIn.toLocaleString()} total — ${t.input.toLocaleString()} new, ${t.cacheRead.toLocaleString()} cached, ${t.cacheWrite.toLocaleString()} cache-write |`)
  lines.push(`| Tokens (out) | ${t.output.toLocaleString()} |`)
  const rm = result.metrics.resourceMetrics
  if (rm) {
    lines.push(`| Peak CPU | ${formatMillicores(rm.peakCpuMillicores)} |`)
    lines.push(`| Avg CPU | ${formatMillicores(rm.avgCpuMillicores)} |`)
    lines.push(`| Peak RAM | ${rm.peakMemoryMiB} MiB |`)
    lines.push(`| Avg RAM | ${rm.avgMemoryMiB} MiB |`)
  }
  lines.push('')

  // Conversation history
  if (ev.conversationHistory?.length) {
    lines.push('## Conversation History')
    lines.push('')
    for (const turn of ev.conversationHistory) {
      lines.push(`**${turn.role}:**`)
      lines.push(`> ${turn.content.replace(/\n/g, '\n> ')}`)
      lines.push('')
    }
  }

  lines.push('## Final Prompt')
  lines.push('')
  lines.push('```')
  lines.push(ev.input)
  lines.push('```')
  lines.push('')

  // Response
  lines.push('## Agent Response')
  lines.push('')
  lines.push(result.responseText || '*No response text*')
  lines.push('')

  // Tool calls
  lines.push(`## Tool Calls (${result.toolCalls.length})`)
  lines.push('')
  for (let i = 0; i < result.toolCalls.length; i++) {
    const tc = result.toolCalls[i]
    const dur = tc.durationMs ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : ''
    const err = tc.error ? ' **ERROR**' : ''
    lines.push(`### ${i + 1}. \`${tc.name}\`${dur}${err}`)
    lines.push('')
    lines.push('<details><summary>Input</summary>')
    lines.push('')
    lines.push('```json')
    try { lines.push(JSON.stringify(tc.input, null, 2)) } catch { lines.push(String(tc.input)) }
    lines.push('```')
    lines.push('</details>')
    lines.push('')
    lines.push('<details><summary>Output</summary>')
    lines.push('')
    lines.push('```json')
    const outStr = typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)
    if (outStr && outStr.length > 4000) {
      lines.push(outStr.slice(0, 4000) + '\n... (truncated)')
    } else {
      lines.push(outStr ?? 'null')
    }
    lines.push('```')
    lines.push('</details>')
    lines.push('')
  }

  // Scoring breakdown
  lines.push('## Scoring Breakdown')
  lines.push('')
  lines.push('| # | Criterion | Phase | Points | Result |')
  lines.push('|---|-----------|-------|--------|--------|')
  for (let i = 0; i < result.criteriaResults.length; i++) {
    const cr = result.criteriaResults[i]
    const icon = cr.passed ? '✅' : '❌'
    const phase = cr.criterion.phase || '-'
    lines.push(`| ${i + 1} | ${cr.criterion.description} | ${phase} | ${cr.pointsEarned}/${cr.criterion.points} | ${icon} |`)
  }
  lines.push('')

  // Penalties
  const toolErrCount = result.metrics.failedToolCalls
  if (toolErrCount > 0 || result.triggeredAntiPatterns.length > 0) {
    lines.push('## Penalties')
    lines.push('')
    if (toolErrCount > 0) {
      const rawPenalty = toolErrCount * 2
      const cappedPenalty = Math.min(rawPenalty, Math.ceil(ev.maxScore * 0.2))
      const capNote = rawPenalty > cappedPenalty ? ` (capped from ${rawPenalty})` : ''
      lines.push(`- ⚠️ Tool errors: ${toolErrCount} failed tool call${toolErrCount !== 1 ? 's' : ''} (−${cappedPenalty} points${capNote})`)
    }
    for (const ap of result.triggeredAntiPatterns) {
      lines.push(`- ⚠️ Anti-pattern: ${ap} (−10 points)`)
    }
    lines.push('')
  }

  // Runtime checks
  if (result.runtimeChecks) {
    const rtc = result.runtimeChecks
    lines.push('## Runtime Checks')
    lines.push('')
    lines.push(`| Check | Result |`)
    lines.push(`|-------|--------|`)
    lines.push(`| Server healthy | ${rtc.serverHealthy === null ? 'N/A' : rtc.serverHealthy ? '✅' : '❌'} |`)
    lines.push(`| Can list models | ${rtc.serverHealthy === null ? 'N/A' : rtc.canListModels ? '✅' : '❌'} |`)
    lines.push(`| Can create record | ${rtc.serverHealthy === null ? 'N/A' : rtc.canCreateRecord ? '✅' : '❌'} |`)
    lines.push(`| Canvas port correct | ${rtc.canvasPortCorrect === null ? 'N/A' : rtc.canvasPortCorrect ? '✅' : '❌'} |`)
    lines.push(`| Canvas compiles | ${rtc.canvasCompiles === null ? 'N/A' : rtc.canvasCompiles ? '✅' : '❌'} |`)
    lines.push(`| Canvas-API contract | ${rtc.canvasFetchesValid === null ? 'N/A' : rtc.canvasFetchesValid ? '✅' : '❌'} |`)
    lines.push(`| Missing routes | ${rtc.missingRoutes.length === 0 ? '✅ none' : '❌ ' + rtc.missingRoutes.join(', ')} |`)
    lines.push('')

    if (rtc.modelResults.length > 0) {
      lines.push('### Per-Model CRUD')
      lines.push('')
      lines.push('| Model | List | Create | Round-trip |')
      lines.push('|-------|------|--------|------------|')
      for (const mr of rtc.modelResults) {
        lines.push(`| ${mr.model} | ${mr.canList ? '✅' : '❌'} | ${mr.canCreate ? '✅' : '❌'} | ${mr.roundTripOk ? '✅' : '❌'} |`)
      }
      lines.push('')
    }

    if (rtc.workspaceIntegrity) {
      const wi = rtc.workspaceIntegrity
      lines.push('### Workspace Integrity')
      lines.push('')
      lines.push('| File | Present |')
      lines.push('|------|---------|')
      lines.push(`| schema.prisma | ${wi.schema ? '✅' : '❌'} (models: ${wi.schemaHasModels ? 'yes' : 'no'}) |`)
      lines.push(`| generated/ | ${wi.generated ? '✅' : '❌'} |`)
      lines.push(`| server.ts | ${wi.server ? '✅' : '❌'} |`)
      lines.push(`| db.ts | ${wi.db ? '✅' : '❌'} |`)
      lines.push(`| @prisma/client | ${wi.prismaClient ? '✅' : '❌'} |`)
      lines.push('')
    }

    if (rtc.errors.length) {
      lines.push('### Runtime Errors')
      lines.push('')
      for (const e of rtc.errors) lines.push(`- ${e}`)
      lines.push('')
    }
  }

  if (result.runtimeWarnings?.length) {
    lines.push('## Runtime Warnings')
    lines.push('')
    for (const w of result.runtimeWarnings) lines.push(`- ${w}`)
    lines.push('')
  }

  if (result.errors?.length) {
    lines.push('## Errors')
    lines.push('')
    for (const e of result.errors) lines.push(`- ${e}`)
    lines.push('')
  }

  const content = lines.join('\n')
  writeFileSync(logPath, content, 'utf-8')
  return content
}

function archiveWorkspaceAsTemplate(
  ev: AgentEval,
  result: EvalResult,
  workspaceDir: string,
  runDir: string,
): string | null {
  if (!existsSync(workspaceDir)) return null

  const destDir = join(runDir, ev.id)
  mkdirSync(destDir, { recursive: true })

  const templateJson = {
    id: ev.id,
    name: ev.name,
    description: `Eval output for "${ev.name}" (${ev.category}, level ${ev.level})`,
    category: ev.category,
    icon: result.passed ? '✅' : '❌',
    tags: [...(ev.tags || []), 'eval-output', trackArg],
    eval: {
      score: result.score,
      maxScore: result.maxScore,
      percentage: result.percentage,
      passed: result.passed,
      durationMs: result.timing.durationMs,
      model: MODEL_MAP[modelArg] || modelArg,
      timestamp: new Date().toISOString(),
      criteria: result.criteriaResults.map(c => ({
        id: c.criterion.id,
        description: c.criterion.description,
        passed: c.passed,
        points: `${c.pointsEarned}/${c.criterion.points}`,
      })),
    },
    runtime: result.runtimeChecks || null,
    runtimeWarnings: result.runtimeWarnings || [],
  }
  writeFileSync(join(destDir, 'template.json'), JSON.stringify(templateJson, null, 2))

  const shogSrc = join(workspaceDir, '.shogo')
  if (existsSync(shogSrc)) {
    cpSync(shogSrc, join(destDir, '.shogo'), { recursive: true })
  }

  const memorySrc = join(workspaceDir, 'memory')
  if (existsSync(memorySrc)) {
    cpSync(memorySrc, join(destDir, 'memory'), { recursive: true })
  }

  const filesSrc = join(workspaceDir, 'files')
  if (existsSync(filesSrc)) {
    cpSync(filesSrc, join(destDir, 'files'), { recursive: true })
  }

  for (const fname of readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!fname.isFile()) continue
    const skip = new Set(['sessions.db', 'sessions.db-wal', 'sessions.db-shm', 'tsconfig.json', 'react-shim.d.ts', 'canvas-globals.d.ts', 'pyrightconfig.json'])
    if (skip.has(fname.name)) continue
    try {
      cpSync(join(workspaceDir, fname.name), join(destDir, fname.name))
    } catch {}
  }

  return destDir
}

// ---------------------------------------------------------------------------
// Eval execution on a worker
// ---------------------------------------------------------------------------

async function runEvalOnWorker(
  worker: DockerWorker,
  ev: AgentEval,
  index: number,
  total: number,
  runTimestamp: string,
  opts?: { skipCleanup?: boolean; runDir?: string },
): Promise<EvalResult> {
  // Force GC between evals to prevent memory pressure crashes in Bun
  try { Bun.gc(true) } catch {}

  const skipCleanup = opts?.skipCleanup ?? false

  if (skipCleanup) {
    // Pipeline continuation — keep workspace intact, only overlay new files
    if (verboseFlag) console.log(`      [setup] Pipeline phase ${ev.pipelinePhase} — keeping workspace`)

    // Idempotent: seed template/skill-server if this phase needs them (no-ops if already present)
    if (ev.useRuntimeTemplate) {
      seedRuntimeTemplate(worker.dir)
      if (verboseFlag) console.log(`      [setup] Seeded runtime template (idempotent)`)
    }
    if (ev.useSkillServer) {
      seedSkillServer(worker.dir)
      if (verboseFlag) console.log(`      [setup] Seeded skill server scaffold (idempotent)`)
    }

    const overlay = ev.pipelineFiles ?? {}
    if (Object.keys(overlay).length > 0) {
      if (verboseFlag) console.log(`      [setup] Writing ${Object.keys(overlay).length} pipeline overlay file(s)`)
      for (const [relPath, content] of Object.entries(overlay)) {
        const absPath = join(worker.dir, relPath)
        mkdirSync(dirname(absPath), { recursive: true })
        writeFileSync(absPath, content, 'utf-8')
      }
    }
  } else if (vmFlag && mountFlag) {
    // 9p mount: the VM manages its own workspace defaults and .shogo is
    // symlinked to a VM-internal path. Only clean non-essential files and
    // write the eval's workspace files from the host; they're visible
    // inside the VM immediately via 9p.
    if (verboseFlag) console.log(`      [setup] Cleaning workspace (9p mount)...`)
    if (existsSync(worker.dir)) {
      const keepEntries = new Set([
        'node_modules', '.shogo', '.virtfs_metadata',
        'tsconfig.json', 'react-shim.d.ts', 'canvas-globals.d.ts', 'pyrightconfig.json',
        'AGENTS.md', 'config.json', 'memory',
      ])
      try {
        for (const entry of readdirSync(worker.dir, { withFileTypes: true })) {
          if (keepEntries.has(entry.name)) continue
          const fullPath = join(worker.dir, entry.name)
          try { rmSync(fullPath, { recursive: true, force: true }) } catch {}
        }
      } catch {}
    }

    if (verboseFlag) console.log(`      [setup] Writing workspace files via 9p...`)
    if (ev.workspaceFiles) {
      for (const [relPath, content] of Object.entries(ev.workspaceFiles)) {
        const absPath = join(worker.dir, relPath)
        mkdirSync(dirname(absPath), { recursive: true })
        writeFileSync(absPath, content, 'utf-8')
      }
      if (verboseFlag) {
        console.log(`      [setup] Workspace files visible via 9p mount (${Object.keys(ev.workspaceFiles).length} file(s))`)
      }
    }
  } else if (k8sFlag) {
    // K8s mode — no shared filesystem; seed workspace via HTTP
    if (verboseFlag) console.log(`      [setup] Seeding workspace via K8s pod HTTP...`)
    const base = getWorkerBaseUrl(worker)

    if (ev.workspaceFiles) {
      const seedRes = await fetch(`${base}/agent/workspace/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: ev.workspaceFiles }),
      })
      if (!seedRes.ok) {
        console.warn(`[setup] Failed to seed workspace files into K8s pod: ${seedRes.status}`)
      } else if (verboseFlag) {
        console.log(`      [setup] Seeded ${Object.keys(ev.workspaceFiles).length} file(s) into K8s pod workspace`)
      }
    }
  } else {
    // Full setup — clean workspace, seed defaults, write workspaceFiles
    if (verboseFlag) console.log(`      [setup] Cleaning workspace...`)

    // Remove stale .shogo symlinks left by previous 9p mount runs
    const shogoPath = join(worker.dir, '.shogo')
    try {
      const st = lstatSync(shogoPath)
      if (st.isSymbolicLink()) {
        try { statSync(shogoPath) } catch { rmSync(shogoPath, { force: true }) }
      }
    } catch {}

    if (existsSync(worker.dir)) {
      const keepEntries = new Set([
        'node_modules', 'sessions.db', 'sessions.db-wal', 'sessions.db-shm',
        '.shogo', 'tsconfig.json',
        'react-shim.d.ts', 'canvas-globals.d.ts', 'pyrightconfig.json',
      ])
      try {
        for (const entry of readdirSync(worker.dir, { withFileTypes: true })) {
          if (keepEntries.has(entry.name)) continue
          const fullPath = join(worker.dir, entry.name)
          try { rmSync(fullPath, { recursive: true, force: true }) } catch {}
        }
      } catch {}
    }
    resetWorkspaceDefaults(worker.dir)
    seedLSPConfig(worker.dir)

    if (ev.useRuntimeTemplate) {
      seedRuntimeTemplate(worker.dir)
      if (verboseFlag) console.log(`      [setup] Seeded runtime template`)
    }
    if (ev.useSkillServer) {
      seedSkillServer(worker.dir)
      if (verboseFlag) console.log(`      [setup] Seeded skill server scaffold`)
    }

    if (verboseFlag) console.log(`      [setup] Seeding workspace files...`)

    if (ev.workspaceFiles) {
      for (const [relPath, content] of Object.entries(ev.workspaceFiles)) {
        const absPath = join(worker.dir, relPath)
        mkdirSync(dirname(absPath), { recursive: true })
        writeFileSync(absPath, content, 'utf-8')
      }

      if (vmFlag) {
        const base = getWorkerBaseUrl(worker)
        const seedRes = await fetch(`${base}/agent/workspace/seed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: ev.workspaceFiles }),
        })
        if (!seedRes.ok) {
          console.warn(`[setup] Failed to seed workspace files into VM: ${seedRes.status}`)
        } else if (verboseFlag) {
          console.log(`      [setup] Seeded ${Object.keys(ev.workspaceFiles).length} file(s) into VM workspace`)
        }
      }
    }
  }

  const pipelineTag = ev.pipeline ? `[${ev.pipeline}:${ev.pipelinePhase}] ` : ''
  const evalLabel = `${pipelineTag}E${index + 1}:${ev.name.replace(/^[^:]*:\s*/, '').toLowerCase().replace(/\s+/g, '-').substring(0, 30)}`
  const initialMode = ev.initialMode || (ev.category === 'canvas' ? 'canvas' : 'none')

  await configureWorkerForTask(worker, {
    model: modelArg,
    mode: initialMode,
    promptProfile: promptProfileArg,
    evalLabel,
    mocks: buildMockPayload(ev.toolMocks),
    verbose: verboseFlag,
  }, k8sFlag ? getWorkerBaseUrl(worker) : undefined)

  if (verboseFlag) console.log(`      [setup] Sending eval prompt...`)

  const startTime = Date.now()
  console.log(`[${evalLabel}] Worker ${worker.id}: ${ev.name}`)

  const statsCollector = (!localFlag && !vmFlag && !k8sFlag) ? new DockerStatsCollector(worker.containerName) : null
  statsCollector?.start()

  try {
    const result = await runEval(ev, {
      agentEndpoint: `${getWorkerBaseUrl(worker)}/agent/chat`,
      timeoutMs: 300_000,
      verbose: verboseFlag,
      workspaceDir: worker.dir,
      agentMode: agentModeArg,
    })

    const resourceMetrics = statsCollector?.stop() ?? null
    if (resourceMetrics) {
      result.metrics.resourceMetrics = resourceMetrics
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const status = result.passed ? 'PASS' : 'FAIL'
    const t = result.metrics.tokens
    const totalIn = t.input + t.cacheRead + t.cacheWrite
    const tokInfo = t.total > 0
      ? ` [${totalIn.toLocaleString()}+${t.output.toLocaleString()} tok` +
        (t.cacheRead > 0 ? ` (${t.cacheRead.toLocaleString()} cached)` : '') + ']'
      : ''
    console.log(`[${evalLabel}] ${status} ${ev.name}: ${result.score}/${ev.maxScore} (${duration}s)${tokInfo}`)

    if (result.promptBreakdown && verboseFlag) {
      const bd = result.promptBreakdown
      const maxLabel = Math.max(...bd.sections.map(s => s.label.length), 'tool-schemas (XX)'.length)
      for (const sec of bd.sections) {
        const tag = sec.zone === 'stable' ? 'S' : 'D'
        console.log(`      ${sec.label.padEnd(maxLabel)} [${tag}]: ${sec.chars.toLocaleString().padStart(7)} chars ~${sec.estTokens.toLocaleString().padStart(6)} tok`)
      }
      console.log(`      ${''.padEnd(maxLabel + 30, '─')}`)
      console.log(`      ${'System prompt total'.padEnd(maxLabel)}    : ${bd.totalChars.toLocaleString().padStart(7)} chars ~${bd.totalEstTokens.toLocaleString().padStart(6)} tok`)
      console.log(`      ${`Tool schemas (${bd.toolCount})`.padEnd(maxLabel)}    : ${bd.toolSchemaChars.toLocaleString().padStart(7)} chars ~${bd.toolSchemaEstTokens.toLocaleString().padStart(6)} tok`)
      console.log(`      ${'Grand total'.padEnd(maxLabel)}    :                ~${bd.grandEstTokens.toLocaleString().padStart(6)} tok`)
    }

    if (result.score > 0) {
      // Force the skill server to regenerate + restart with the latest schema
      // before probing routes. This eliminates file-watcher timing races.
      if (ev.useSkillServer) {
        try {
          if (verboseFlag) console.log(`      [runtime] Syncing skill server...`)
          const syncRes = await fetch(`${getWorkerBaseUrl(worker)}/agent/skill-server/sync`, {
            method: 'POST',
            signal: AbortSignal.timeout(180_000),
          })
          const text = await syncRes.text()
          try {
            const syncBody = JSON.parse(text) as { ok: boolean; phase: string; error?: string }
            if (verboseFlag) console.log(`      [runtime] Skill server sync: ok=${syncBody.ok} phase=${syncBody.phase}${syncBody.error ? ` error=${syncBody.error}` : ''}`)
          } catch {
            if (verboseFlag) console.log(`      [runtime] Skill server sync: HTTP ${syncRes.status} (non-JSON: ${text.slice(0, 200)})`)
          }
        } catch (err: any) {
          console.warn(`      [runtime] Skill server sync failed: ${err.message}`)
        }
      }

      let runtimeResults: RuntimeCheckResults | null = null
      if (k8sFlag) {
        try {
          const res = await fetch(`${getWorkerBaseUrl(worker)}/agent/runtime-checks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canvasExpectedPort: CONTAINER_SKILL_PORT, evalId: ev.id, verbose: verboseFlag }),
            signal: AbortSignal.timeout(120_000),
          })
          const body = await res.json() as { ok: boolean; results: RuntimeCheckResults | null; error?: string }
          if (body.ok) runtimeResults = body.results
          else if (verboseFlag) console.log(`      [runtime] Remote runtime checks failed: ${body.error}`)
        } catch (err: any) {
          console.warn(`      [runtime] Remote runtime checks error: ${err.message}`)
        }
      } else {
        const hostSkillPort = SKILL_SERVER_BASE_PORT + worker.id
        const canvasExpected = (localFlag || vmFlag) ? hostSkillPort : CONTAINER_SKILL_PORT
        runtimeResults = await runRuntimeChecks({
          workspaceDir: worker.dir,
          skillServerPort: hostSkillPort,
          canvasExpectedPort: canvasExpected,
          evalId: ev.id,
          verbose: verboseFlag,
        })
      }
      if (runtimeResults) {
        result.runtimeChecks = runtimeResults
        result.runtimeWarnings = result.runtimeWarnings || []

        const isFullstack = ev.useSkillServer === true

        const runtimeCriteria: { id: string; desc: string; pts: number; passed: boolean; skip?: boolean }[] = [
          {
            id: 'runtime-server-healthy',
            desc: 'Skill server boots and responds to /health',
            pts: 2,
            passed: runtimeResults.serverHealthy === true,
            skip: runtimeResults.serverHealthy === null,
          },
          {
            id: 'runtime-crud-functional',
            desc: 'Can list and create records via API',
            pts: 2,
            passed: runtimeResults.canListModels && runtimeResults.canCreateRecord,
            skip: runtimeResults.serverHealthy === null || !runtimeResults.workspaceIntegrity?.schemaHasModels,
          },
          {
            id: 'runtime-canvas-port',
            desc: 'Canvas references the correct skill server port',
            pts: 1,
            passed: runtimeResults.canvasPortCorrect === true,
            skip: runtimeResults.canvasPortCorrect === null,
          },
          {
            id: 'runtime-canvas-compiles',
            desc: 'Canvas app source files transpile without syntax errors',
            pts: 3,
            passed: runtimeResults.canvasCompiles === true,
            skip: runtimeResults.canvasCompiles === null,
          },
        ]

        let runtimeBonus = 0
        let runtimeMaxBonus = 0
        for (const rc of runtimeCriteria) {
          if (rc.skip) continue
          runtimeMaxBonus += rc.pts
          const earned = rc.passed ? rc.pts : 0
          runtimeBonus += earned
          result.criteriaResults.push({
            criterion: { id: rc.id, description: rc.desc, points: rc.pts, phase: 'execution', validate: () => rc.passed },
            passed: rc.passed,
            pointsEarned: earned,
          })
        }

        result.score += runtimeBonus
        result.maxScore += runtimeMaxBonus

        // For fullstack evals (useSkillServer), runtime failures are penalties
        // that deduct from the static score — a broken server can't pass.
        const hasModels = runtimeResults.workspaceIntegrity?.schemaHasModels === true
        if (isFullstack && hasModels) {
          let penalty = 0
          if (runtimeResults.serverHealthy === false) {
            penalty += Math.ceil(ev.maxScore * 0.25)
          }
          if (!runtimeResults.canListModels || !runtimeResults.canCreateRecord) {
            penalty += Math.ceil(ev.maxScore * 0.15)
          }
          if (penalty > 0) {
            result.score = Math.max(0, result.score - penalty)
            result.runtimeWarnings.push(`Runtime penalty: −${penalty} pts (server/CRUD failures)`)
          }
        }

        // Canvas-API contract: penalise when the UI fetches routes that don't
        // exist. Each unique orphaned route costs 2 pts, capped at 20% of maxScore.
        const orphaned = runtimeResults.canvasOrphanedFetches ?? []
        if (orphaned.length > 0) {
          const uniqueOrphaned = new Set(orphaned.map(r => r.toLowerCase()))
          const rawPenalty = uniqueOrphaned.size * 2
          const contractPenalty = Math.min(rawPenalty, Math.ceil(ev.maxScore * 0.2))
          result.score = Math.max(0, result.score - contractPenalty)
          result.runtimeWarnings.push(`Canvas-API contract penalty: −${contractPenalty} pts (${uniqueOrphaned.size} orphaned route${uniqueOrphaned.size !== 1 ? 's' : ''})`)
        }

        result.percentage = result.maxScore > 0 ? (result.score / result.maxScore) * 100 : 0
        result.passed = result.percentage >= 70 && result.triggeredAntiPatterns.length === 0

        if (runtimeResults.serverHealthy === false) {
          result.runtimeWarnings.push('Skill server health check failed')
        }
        if (runtimeResults.canvasPortCorrect === false) {
          result.runtimeWarnings.push('Canvas references wrong skill server port')
        }
        if (runtimeResults.canvasCompiles === false) {
          const errCount = runtimeResults.canvasCompileErrors.length
          result.runtimeWarnings.push(`Canvas compilation failed (${errCount} error${errCount !== 1 ? 's' : ''})`)
        }

        const warns = result.runtimeWarnings.length
        if (warns > 0) {
          console.log(`[${evalLabel}] Runtime: ${warns} warning(s) — ${result.runtimeWarnings.join(', ')}`)
        }
        console.log(`[${evalLabel}] Runtime score: +${runtimeBonus}/${runtimeMaxBonus} → ${result.score}/${result.maxScore} (${result.percentage.toFixed(1)}%) ${result.passed ? 'PASS' : 'FAIL'}`)
      }
    }

    if (saveWorkspacesFlag && opts?.runDir) {
      const archivePath = archiveWorkspaceAsTemplate(ev, result, worker.dir, opts.runDir)
      if (archivePath) {
        result.workspaceDir = archivePath
        console.log(`[${evalLabel}] Workspace saved: ${archivePath}`)
      }
    }

    return result
  } catch (err: any) {
    const resourceMetrics = statsCollector?.stop() ?? null
    console.error(`[${evalLabel}] ERROR ${ev.name}: ${err.message}`)
    return {
      eval: ev,
      passed: false,
      score: 0,
      maxScore: ev.maxScore,
      percentage: 0,
      responseText: '',
      toolCalls: [],
      finalTurnToolCalls: [],
      perTurnToolCalls: [],
      criteriaResults: [],
      triggeredAntiPatterns: [],
      timing: { startTime, endTime: Date.now(), durationMs: Date.now() - startTime },
      metrics: {
        toolCallCount: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        iterations: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        timing: { totalMs: Date.now() - startTime },
        ...(resourceMetrics ? { resourceMetrics } : {}),
      },
      errors: [err.message],
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []
const stopWorker = k8sFlag ? stopK8sWorkerSync : vmFlag ? stopVMWorker : localFlag ? stopLocalWorker : stopDockerWorker

async function cleanupWorkers(workers: DockerWorker[]): Promise<void> {
  if (k8sFlag) {
    await Promise.allSettled(workers.map(w => stopK8sWorker(w)))
  } else {
    workers.forEach(stopWorker)
  }
}

registerCleanupHandlers(() => globalWorkers, 'agent-eval-crash.log', { stopWorker })

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log(`AGENT RUNTIME EVAL (${k8sFlag ? 'K8s' : vmFlag ? 'VM' : localFlag ? 'Local' : 'Docker'})`)
  console.log('='.repeat(60))
  console.log(`  Track:      ${trackArg}`)
  console.log(`  Model:      ${MODEL_MAP[modelArg] || modelArg}`)
  if (agentModeArg) console.log(`  Agent Mode: ${agentModeArg}`)
  console.log(`  Workers:    ${workersArg}`)
  console.log(`  Mode:       ${k8sFlag ? 'K8s pod' : vmFlag ? (mountFlag ? 'VM instance (9p mount)' : 'VM instance') : localFlag ? 'local process' : 'docker container'}`)
  if (saveWorkspacesFlag) console.log(`  Save:    ON (template format)`)
  console.log('')

  let evals = getEvals(trackArg)
  if (filterArg) {
    const f = filterArg.toLowerCase()
    evals = evals.filter(e => e.id.toLowerCase().includes(f) || e.name.toLowerCase().includes(f))
  }
  if (tagsArg) {
    const requiredTags = tagsArg.split(',').map(t => t.trim().toLowerCase())
    evals = evals.filter(e => e.tags?.some(t => requiredTags.includes(t.toLowerCase())))
  }
  const workQueue = buildWorkQueue(evals)
  const pipelineCount = workQueue.filter(w => w.type === 'pipeline').length
  const standaloneCount = workQueue.filter(w => w.type === 'standalone').length
  console.log(`  Evals:      ${evals.length}`)
  if (pipelineCount > 0) {
    console.log(`  Pipelines:  ${pipelineCount} (${evals.length - standaloneCount} evals)`)
    console.log(`  Standalone: ${standaloneCount}`)
  }
  console.log('')

  if (evals.length === 0) {
    console.log('No evals found')
    process.exit(1)
  }

  // Worker config setup — one of four backends
  let dockerWorkerConfig: DockerWorkerConfig | undefined
  let localWorkerConfig: LocalWorkerConfig | undefined
  let vmWorkerConfig: VMWorkerConfig | undefined
  let k8sWorkerConfig: K8sWorkerConfig | undefined

  if (k8sFlag) {
    const image = process.env.RUNTIME_IMAGE || DEFAULT_RUNTIME_IMAGE
    const namespace = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
    k8sWorkerConfig = {
      containerPrefix: 'eval-worker',
      baseHostPort: BASE_PORT,
      model: modelArg,
      verbose: verboseFlag,
      image,
      namespace,
      runId: runIdArg,
      envOverrides: {
        AGENT_MAX_ITERATIONS: '100',
        WEB_CACHE_REDIS_URL: `redis://redis-master.${namespace}:6379`,
      },
    }
  } else if (vmFlag) {
    vmWorkerConfig = {
      containerPrefix: 'eval-vm',
      baseHostPort: BASE_PORT,
      model: modelArg,
      verbose: verboseFlag,
      mount: mountFlag,
    }
  } else if (localFlag) {
    localWorkerConfig = {
      containerPrefix: 'eval-worker',
      baseHostPort: BASE_PORT,
      skillServerBasePort: SKILL_SERVER_BASE_PORT,
      model: modelArg,
      verbose: verboseFlag,
    }
  } else {
    const image = DEFAULT_RUNTIME_IMAGE
    await ensureDockerImage(image, { build: buildFlag })
    writeDockerEnvFile()
    dockerWorkerConfig = evalWorkerConfig({
      image,
      containerPrefix: 'eval-worker',
      baseHostPort: BASE_PORT,
      extraPortMappings: [{ hostBase: SKILL_SERVER_BASE_PORT, container: CONTAINER_SKILL_PORT }],
      model: modelArg,
      verbose: verboseFlag,
    })
  }

  // Start workers
  console.log('Starting workers...')
  const workers: DockerWorker[] = []
  try {
    for (let i = 0; i < workersArg; i++) {
      const w = k8sFlag
        ? await startK8sWorker(i, k8sWorkerConfig!)
        : vmFlag
          ? await startVMWorker(i, vmWorkerConfig!)
          : localFlag
            ? await startLocalWorker(i, localWorkerConfig!)
            : await startDockerWorker(i, dockerWorkerConfig!)
      workers.push(w)
      globalWorkers.push(w)
      if (i < workersArg - 1) await Bun.sleep(1_000)
    }
  } catch (err: any) {
    console.error(`Failed to start workers: ${err.message}`)
    await cleanupWorkers(globalWorkers)
    globalWorkers = []
    if (!localFlag && !k8sFlag) cleanupDockerEnvFile()
    process.exit(1)
  }

  // VM preflight: verify workspace provisioning inside the VM
  if (vmFlag) {
    console.log('Running VM preflight checks...')
    let preflightOk = true
    for (const w of workers) {
      try {
        const res = await fetch(`${getWorkerBaseUrl(w)}/health`, { signal: AbortSignal.timeout(5_000) })
        const body = await res.json() as any
        const ws = body?.workspace
        const tpl = ws?.templateSeeded
        const deps = ws?.depsInstalled
        const status = `templateSeeded=${tpl ?? 'n/a'}, depsInstalled=${deps ?? 'n/a'}`
        if (tpl && deps) {
          console.log(`  Worker ${w.id}: ${status} ✓`)
        } else {
          console.warn(`  Worker ${w.id}: ${status} ✗`)
          preflightOk = false
        }
      } catch (err: any) {
        console.warn(`  Worker ${w.id}: preflight failed — ${err.message}`)
        preflightOk = false
      }
    }
    if (!preflightOk) {
      console.warn('\n⚠  VM preflight: workspace not fully provisioned. Template or deps may be missing.')
      console.warn('   Evals with useRuntimeTemplate will likely fail. Rebuild the VM image.')
      console.warn('')
    } else {
      console.log('  VM preflight passed.\n')
    }
  }

  console.log('')
  console.log('Running evals...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const results: EvalResult[] = []
  const partialPath = resolve(tmpdir(), `agent-eval-partial-${modelArg}-${trackArg}.json`)

  const runDir = join(EVAL_OUTPUTS_DIR, `${trackArg}-${modelArg}-${runTimestamp}`)
  mkdirSync(join(runDir, 'logs'), { recursive: true })
  console.log(`  Logs: ${join(runDir, 'logs')}`)

  if (saveWorkspacesFlag) {
    console.log(`  Workspaces will be saved to: ${runDir}`)
  }
  console.log('')

  // Parallel work-pool: each worker pulls the next work item from the queue.
  // Pipelines run all phases sequentially on one worker; standalone evals run individually.
  let nextItemIndex = 0
  let globalEvalIndex = 0

  const workerStatus: Record<number, {
    workerId: number
    containerName: string
    status: 'idle' | 'running' | 'done'
    currentEval?: string
    currentEvalName?: string
    pipeline?: string
    pipelinePhase?: number
    pipelineTotal?: number
    evalsCompleted: number
    startedAt?: string
  }> = {}
  for (const w of workers) {
    workerStatus[w.id] = {
      workerId: w.id,
      containerName: w.containerName,
      status: 'idle',
      evalsCompleted: 0,
    }
  }

  async function ensureWorkerHealthy(worker: DockerWorker) {
    const healthy = k8sFlag
      ? await (await import('./k8s-worker')).isK8sWorkerHealthy(worker)
      : await isWorkerHealthy(worker)
    if (!healthy) {
      if (verboseFlag) console.log(`      [lifecycle] Worker ${worker.id} unhealthy, restarting...`)
      stopWorker(worker)
      await Bun.sleep(500)
      const fresh = k8sFlag
        ? await startK8sWorker(worker.id, k8sWorkerConfig!)
        : localFlag
          ? await startLocalWorker(worker.id, localWorkerConfig!, { workspaceDir: worker.dir })
          : await startDockerWorker(worker.id, dockerWorkerConfig!, { workspaceDir: worker.dir })
      Object.assign(worker, fresh)
    }
  }

  const evalLogs: Record<string, string> = {}

  function buildProgressPayload() {
    const progressData = results.map(rr => ({ id: rr.eval.id, score: rr.score, max: rr.maxScore, passed: rr.passed }))
    return {
      results: progressData,
      totalEvals: evals.length,
      queueLength: workQueue.length,
      queueRemaining: Math.max(0, workQueue.length - nextItemIndex),
      workers: Object.values(workerStatus),
    }
  }

  async function reportProgress() {
    const payload = buildProgressPayload()
    try { writeFileSync(partialPath, JSON.stringify(payload.results, null, 2)) } catch {}
    if (useCallback) {
      await postCallbackSafe(`/evals/${runIdArg}/progress`, payload)
    }
  }

  async function runAndRecord(worker: DockerWorker, ev: AgentEval, skipCleanup: boolean) {
    const idx = globalEvalIndex++
    workerStatus[worker.id] = {
      ...workerStatus[worker.id],
      status: 'running',
      currentEval: ev.id,
      currentEvalName: ev.name,
      startedAt: new Date().toISOString(),
    }
    await reportProgress()
    await ensureWorkerHealthy(worker)
    const result = await runEvalOnWorker(worker, ev, idx, evals.length, runTimestamp, { skipCleanup, runDir })
    results.push(result)
    workerStatus[worker.id].evalsCompleted++
    let logContent: string | undefined
    try {
      logContent = writeEvalLog(result, runDir)
      evalLogs[result.eval.id] = logContent
    } catch {}
    await reportProgress()
    if (useCallback) {
      await postCallbackSafe(`/evals/${runIdArg}/result`, {
        result: {
          eval: { id: result.eval.id, name: result.eval.name, category: result.eval.category, level: result.eval.level, pipeline: result.eval.pipeline, pipelinePhase: result.eval.pipelinePhase },
          passed: result.passed,
          score: result.score,
          maxScore: result.maxScore,
          percentage: result.percentage,
          timing: result.timing,
          metrics: { tokens: result.metrics.tokens, toolCallCount: result.metrics.toolCallCount, failedToolCalls: result.metrics.failedToolCalls, iterations: result.metrics.iterations },
          phaseScores: result.phaseScores ?? null,
          criteriaResults: result.criteriaResults,
          triggeredAntiPatterns: result.triggeredAntiPatterns,
          errors: result.errors,
          runtimeWarnings: result.runtimeWarnings,
        },
        log: logContent ?? null,
      })
    }
    return result
  }

  async function workerLoop(worker: DockerWorker) {
    while (nextItemIndex < workQueue.length) {
      const item = workQueue[nextItemIndex++]

      try {
        if (item.type === 'standalone') {
          workerStatus[worker.id].pipeline = undefined
          workerStatus[worker.id].pipelinePhase = undefined
          workerStatus[worker.id].pipelineTotal = undefined
          await runAndRecord(worker, item.eval, false)
        } else {
          console.log(`[Worker ${worker.id}] Pipeline "${item.name}" — ${item.phases.length} phases`)
          for (let p = 0; p < item.phases.length; p++) {
            workerStatus[worker.id].pipeline = item.name
            workerStatus[worker.id].pipelinePhase = p + 1
            workerStatus[worker.id].pipelineTotal = item.phases.length
            await runAndRecord(worker, item.phases[p], p > 0)
          }
          console.log(`[Worker ${worker.id}] Pipeline "${item.name}" complete`)
        }
      } catch (err: any) {
        console.error(`[Worker ${worker.id}] Work item failed: ${err?.message || err}`)
      }
    }
    workerStatus[worker.id].status = 'done'
    workerStatus[worker.id].currentEval = undefined
    workerStatus[worker.id].currentEvalName = undefined
    workerStatus[worker.id].pipeline = undefined
    workerStatus[worker.id].pipelinePhase = undefined
    workerStatus[worker.id].pipelineTotal = undefined
    await reportProgress()
  }

  await Promise.all(workers.map(w => workerLoop(w)))

  const totalTime = (Date.now() - overallStart) / 1000

  // Stop workers
  console.log('')
  console.log('Stopping workers...')
  await cleanupWorkers(workers)
  globalWorkers = []
  if (!localFlag && !k8sFlag) cleanupDockerEnvFile()

  // Summary
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const avgScore = results.length > 0
    ? results.reduce((s, r) => s + r.score, 0) / results.length
    : 0
  const totalInput = results.reduce((s, r) => s + r.metrics.tokens.input, 0)
  const totalOutput = results.reduce((s, r) => s + r.metrics.tokens.output, 0)
  const totalCacheRead = results.reduce((s, r) => s + r.metrics.tokens.cacheRead, 0)
  const totalCacheWrite = results.reduce((s, r) => s + r.metrics.tokens.cacheWrite, 0)
  const pricing = PRICING[modelArg]
  const totalCost = pricing
    ? totalInput * pricing.input +
      totalOutput * pricing.output +
      totalCacheRead * pricing.cacheRead +
      totalCacheWrite * pricing.cacheWrite
    : calculateDollarCost(modelArg, totalInput, totalOutput, totalCacheRead, totalCacheWrite)
  const totalToolCalls = results.reduce((s, r) => s + r.metrics.toolCallCount, 0)
  const totalFailed = results.reduce((s, r) => s + r.metrics.failedToolCalls, 0)

  // Phase scores
  let intentTotal = 0, intentMax = 0, execTotal = 0, execMax = 0
  for (const r of results) {
    if (r.phaseScores) {
      intentTotal += r.phaseScores.intention.score
      intentMax += r.phaseScores.intention.maxScore
      execTotal += r.phaseScores.execution.score
      execMax += r.phaseScores.execution.maxScore
    }
  }

  // By category
  const categories = new Set(evals.map(e => e.category))
  const byCategory: Record<string, CategorySummary> = {}
  for (const cat of categories) {
    const catResults = results.filter(r => r.eval.category === cat)
    const catPassed = catResults.filter(r => r.passed).length
    byCategory[cat] = {
      total: catResults.length,
      passed: catPassed,
      failed: catResults.length - catPassed,
      passRate: catResults.length > 0 ? (catPassed / catResults.length) * 100 : 0,
      avgScore: catResults.length > 0
        ? catResults.reduce((s, r) => s + r.score, 0) / catResults.length
        : 0,
    }
  }

  console.log('')
  console.log('='.repeat(60))
  console.log('RESULTS')
  console.log('='.repeat(60))
  console.log(`  Total:    ${results.length}`)
  console.log(`  Passed:   ${passed} (${(passed / results.length * 100).toFixed(1)}%)`)
  console.log(`  Failed:   ${failed}`)
  console.log(`  Avg Score: ${avgScore.toFixed(1)}`)
  console.log('')

  console.log('INTENTION vs EXECUTION')
  console.log('-'.repeat(40))
  console.log(`  Intention: ${intentMax > 0 ? (intentTotal / intentMax * 100).toFixed(1) : 100}% (${intentTotal}/${intentMax})`)
  console.log(`  Execution: ${execMax > 0 ? (execTotal / execMax * 100).toFixed(1) : 100}% (${execTotal}/${execMax})`)
  console.log('')

  console.log('EFFICIENCY METRICS')
  console.log('-'.repeat(40))
  console.log(`  Total tool calls:   ${totalToolCalls}`)
  console.log(`  Failed tool calls:  ${totalFailed}`)
  console.log(`  Avg tools/eval:     ${(totalToolCalls / results.length).toFixed(1)}`)
  console.log(`  Success rate:       ${totalToolCalls > 0 ? ((1 - totalFailed / totalToolCalls) * 100).toFixed(1) : 100}%`)
  console.log(`  Error penalty:      −${totalFailed * 2} points raw (${totalFailed} × 2), capped at 20% per eval`)
  console.log('')

  // Resource usage summary (Docker mode only)
  const resourceResults = results.filter(r => r.metrics.resourceMetrics)
  let resourceSummary: ResourceSummary | undefined
  if (resourceResults.length > 0) {
    const peakCpu = Math.max(...resourceResults.map(r => r.metrics.resourceMetrics!.peakCpuMillicores))
    const avgCpu = resourceResults.reduce((s, r) => s + r.metrics.resourceMetrics!.avgCpuMillicores, 0) / resourceResults.length
    const peakMem = Math.max(...resourceResults.map(r => r.metrics.resourceMetrics!.peakMemoryMiB))
    const avgMem = resourceResults.reduce((s, r) => s + r.metrics.resourceMetrics!.avgMemoryMiB, 0) / resourceResults.length

    resourceSummary = {
      peakCpuMillicores: Math.round(peakCpu),
      avgCpuMillicores: Math.round(avgCpu),
      peakMemoryMiB: Math.round(peakMem * 10) / 10,
      avgMemoryMiB: Math.round(avgMem * 10) / 10,
    }

    console.log('RESOURCE USAGE')
    console.log('-'.repeat(40))
    console.log(`  Peak CPU:           ${formatMillicores(resourceSummary.peakCpuMillicores)}`)
    console.log(`  Avg CPU:            ${formatMillicores(resourceSummary.avgCpuMillicores)}`)
    console.log(`  Peak Memory:        ${resourceSummary.peakMemoryMiB} MiB`)
    console.log(`  Avg Memory:         ${resourceSummary.avgMemoryMiB} MiB`)
    console.log(`  Samples:            ${resourceResults.length} evals tracked`)
    console.log('')
  }

  if (totalFailed > 0) {
    const errorsByTool = new Map<string, { count: number; evals: string[] }>()
    for (const r of results) {
      for (const tc of r.toolCalls) {
        if (!tc.error) continue
        const entry = errorsByTool.get(tc.name) || { count: 0, evals: [] }
        entry.count++
        if (!entry.evals.includes(r.eval.id)) entry.evals.push(r.eval.id)
        errorsByTool.set(tc.name, entry)
      }
    }
    const sorted = [...errorsByTool.entries()].sort((a, b) => b[1].count - a[1].count)

    console.log('TOOL ERRORS')
    console.log('-'.repeat(60))
    for (const [tool, { count, evals: evalIds }] of sorted) {
      console.log(`  ${tool.padEnd(28)} ${String(count).padStart(3)} error${count !== 1 ? 's' : ''} across ${evalIds.length} eval${evalIds.length !== 1 ? 's' : ''}`)
    }
    console.log('')
  }

  const cacheHitRate = (totalInput + totalCacheRead + totalCacheWrite) > 0
    ? (totalCacheRead / (totalInput + totalCacheRead + totalCacheWrite) * 100).toFixed(1)
    : '0.0'
  const totalInputAll = totalInput + totalCacheRead + totalCacheWrite
  console.log('COST')
  console.log('-'.repeat(40))
  console.log(`  Total input tokens: ${totalInputAll.toLocaleString()}`)
  console.log(`    New (uncached):   ${totalInput.toLocaleString()}`)
  console.log(`    Cache read:       ${totalCacheRead.toLocaleString()} (${cacheHitRate}% hit rate)`)
  console.log(`    Cache write:      ${totalCacheWrite.toLocaleString()}`)
  console.log(`  Output tokens:      ${totalOutput.toLocaleString()}`)
  console.log(`  Total cost:         $${totalCost.toFixed(4)}`)
  console.log(`  Cost/eval:          $${(totalCost / results.length).toFixed(4)}`)
  console.log(`  Duration:           ${totalTime.toFixed(1)}s`)
  console.log('')

  if (Object.keys(byCategory).length > 1) {
    console.log('BY CATEGORY')
    console.log('-'.repeat(50))
    for (const [cat, summary] of Object.entries(byCategory)) {
      console.log(`  ${cat.padEnd(15)} ${summary.passed}/${summary.total} (${summary.passRate.toFixed(0)}%) avg=${summary.avgScore.toFixed(0)}`)
    }
    console.log('')
  }

  console.log('INDIVIDUAL RESULTS')
  console.log('-'.repeat(100))
  console.log('  Name'.padEnd(42) + 'Score'.padEnd(10) + 'Intent'.padEnd(10) + 'Exec'.padEnd(10) + 'Tools'.padEnd(8) + 'Tokens (in/out)')
  console.log('-'.repeat(100))
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL'
    const name = `${status} ${r.eval.name}`.slice(0, 40)
    const score = `${r.score}/${r.eval.maxScore}`
    const intent = r.phaseScores ? `${r.phaseScores.intention.percentage.toFixed(0)}%` : '-'
    const exec = r.phaseScores ? `${r.phaseScores.execution.percentage.toFixed(0)}%` : '-'
    const tools = String(r.metrics.toolCallCount)
    const rt = r.metrics.tokens
    const rTotalIn = rt.input + rt.cacheRead + rt.cacheWrite
    const tokStr = `${rTotalIn.toLocaleString()}/${rt.output.toLocaleString()}` +
      (rt.cacheRead > 0 ? ` (${(rt.cacheRead / rTotalIn * 100).toFixed(0)}% cached)` : '')
    console.log(`  ${name.padEnd(40)} ${score.padEnd(10)} ${intent.padEnd(10)} ${exec.padEnd(10)} ${tools.padEnd(8)} ${tokStr}`)
  }

  // Save results
  const timestamp = Date.now()
  const outputPath = resolve(tmpdir(), `agent-eval-results-${modelArg}-${trackArg}-${timestamp}.json`)
  const exportData: EvalSuiteResult = {
    name: `agent-runtime-${trackArg}`,
    timestamp: new Date().toISOString(),
    model: MODEL_MAP[modelArg] || modelArg,
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: (passed / results.length) * 100,
      avgScore,
      totalPoints: results.reduce((s, r) => s + r.score, 0),
      maxPoints: results.reduce((s, r) => s + r.maxScore, 0),
    },
    byCategory,
    cost: {
      totalInputTokens: totalInput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheWriteTokens: totalCacheWrite,
      totalOutputTokens: totalOutput,
      totalCost,
      costPerEval: totalCost / results.length,
    },
    ...(resourceSummary ? { resources: resourceSummary } : {}),
  }
  const summaryPath = join(runDir, 'results.json')
  writeFileSync(summaryPath, JSON.stringify(exportData, null, 2))
  writeFileSync(outputPath, JSON.stringify(exportData, null, 2))
  console.log('')
  console.log(`Results: ${summaryPath}`)
  console.log(`Logs:    ${join(runDir, 'logs')}`)

  if (useCallback) {
    try {
      await postCallback(`/evals/${runIdArg}/complete`, { suite: exportData, logs: evalLogs }, 60_000)
    } catch {
      console.warn(`[callback] /complete with full payload failed, retrying summary-only…`)
      const lightweight = { ...exportData, results: [] }
      await postCallbackSafe(`/evals/${runIdArg}/complete`, { suite: lightweight, logs: {} }, 30_000)
    }
  }

  if (saveWorkspacesFlag) {
    console.log('')
    console.log('SAVED WORKSPACES (template format)')
    console.log('-'.repeat(60))
    console.log(`  Directory: ${runDir}`)
    for (const r of results) {
      if (r.workspaceDir) {
        const status = r.passed ? 'PASS' : 'FAIL'
        console.log(`  ${status} ${r.eval.id} → ${r.workspaceDir}`)
      }
    }
    console.log('')
    console.log('  To load as a template, copy any eval directory into:')
    console.log(`  ${resolve(REPO_ROOT, 'packages/agent-runtime/templates/')}`)
  }

  console.log('='.repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async err => {
  console.error('Fatal:', err)
  if (useCallback) {
    await postCallbackSafe(`/evals/${runIdArg}/fail`, { error: String(err?.message ?? err) })
  }
  await cleanupWorkers(globalWorkers)
  globalWorkers = []
  if (!localFlag && !k8sFlag) cleanupDockerEnvFile()
  process.exit(1)
})
