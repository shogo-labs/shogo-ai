#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Seeds the "engineering team in a channel" demo into a running Shogo API.
 *
 * Idempotent: every step looks before it creates, so run it again after a
 * partial failure or before each rehearsal. It talks to the API over HTTP with
 * an API key, the same way `e2e/issue-pipeline/l1-eng-pod-metrics` does.
 *
 *   1. Coordinator project   created from the `eng-pod` template (or reused).
 *   2. Team                  writes the template's `shogo-system.yaml` to the
 *                            coordinator, whose agent runs `system_apply`, which
 *                            creates the builder and reviewer projects, wires
 *                            them and creates `#eng`. Goes through the API's
 *                            agent proxy unless AGENT_URL names the runtime.
 *   3. Fixture repo          `--reset-repo` force-pushes the checkout app (with
 *                            its coupon bug) to GITHUB_TEST_REPO's main.
 *   4. GitHub                connects the three projects to GITHUB_TEST_REPO
 *                            (needs GITHUB_INSTALLATION_ID); each checkout is
 *                            reset onto the repo's main.
 *   5. Briefing              a weekday 9am routine whose result lands in `#eng`
 *                            (`--run-briefing` runs it now).
 *   6. Slack                 `--slack` switches the workspace to bridged Slack
 *                            chat so the same thread shows up there.
 *
 * Usage:
 *   SHOGO_API_URL=http://localhost:8002 SHOGO_API_KEY=shogo_sk_... \
 *   WORKSPACE_ID=<id> GITHUB_TEST_REPO=<owner>/<repo> \
 *   GITHUB_INSTALLATION_ID=<n> \
 *     bun run scripts/demo/seed-eng-pod.ts [--reset-repo] [--run-briefing] [--slack]
 *
 * Optional env: AGENT_URL (the coordinator's runtime; defaults to the API's agent
 * proxy for the coordinator project), COORDINATOR_PROJECT_ID (reuse a project), MAINTAINER_USER_IDS, BRIEFING_CRON
 * (default `0 9 * * 1-5`), BRIEFING_TIMEZONE (default UTC), FIXTURE_DIR.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_NAMES, COORDINATOR_KEY, BUILDER_KEY, REVIEWER_KEY } from '../../packages/agent-runtime/src/eng-pod-manifest-gen'

export const TEMPLATE_ID = 'eng-pod'
export const TEAM_CHANNEL = 'eng'
export const BRIEFING_NAME = 'Engineering morning briefing'
export const DEFAULT_BRIEFING_CRON = '0 9 * * 1-5'

export interface SeedFlags {
  resetRepo: boolean
  runBriefing: boolean
  slack: boolean
}

export interface SeedConfig {
  workspaceId: string
  githubRepo?: string
  githubInstallationId?: number
  /** Reuse this project as the coordinator instead of looking one up by name. */
  coordinatorProjectId?: string
  briefingCron: string
  briefingTimezone: string
  briefingPrompt: string
  /** The generated `shogo-system.yaml`, written to the coordinator before it applies it. */
  manifestYaml: string
  /** Workspace user ids to put in @maintainers (the channel's human members). */
  maintainerUserIds: string[]
  flags: SeedFlags
}

export interface SeedDeps {
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<T>
  /** Sends a message to the coordinator's runtime and returns its reply. */
  askCoordinator?: (message: string, coordinatorProjectId: string) => Promise<string>
  /** Force-pushes the fixture repo's baseline; absent when GITHUB_TEST_REPO is not set. */
  resetRepo?: () => Promise<void>
  log: (line: string) => void
}

export interface SeedResult {
  coordinatorProjectId: string
  channelId: string | null
  projectIds: Partial<Record<'coordinator' | 'builder' | 'reviewer', string>>
  scheduleId: string | null
  /** Things a person still has to do. */
  todo: string[]
}

export const APPLY_PROMPT =
  'Call system_apply now (dryRun: false, not a dry run) on shogo-system.yaml, which is in this project\'s folder. If system_apply cannot find it at the workspace root, read the file and pass its content as the `manifest` parameter. When it finishes, reply with the created channel and the project names, and anything it lists as manual.'

export const REAPPLY_PROMPT =
  'Call system_apply again (dryRun: false) on the same manifest: projects it created a moment ago were not reachable on disk the first time, so their files were skipped. Reply with what it applied and anything it still skipped.'

const MAX_APPLY_ATTEMPTS = 3

export function parseFlags(argv: string[]): SeedFlags {
  return {
    resetRepo: argv.includes('--reset-repo'),
    runBriefing: argv.includes('--run-briefing'),
    slack: argv.includes('--slack'),
  }
}

/** Routine prompt shipped with the template (same file the plan's "briefing" refers to). */
export function readBriefingPrompt(): string {
  return readFileSync(join(import.meta.dir, '../../packages/agent-runtime/templates/eng-pod/briefing.prompt.md'), 'utf-8').trim()
}

/** The template's generated manifest: it carries every agent's prompt files. */
export function readManifestYaml(): string {
  return readFileSync(join(import.meta.dir, '../../packages/agent-runtime/templates/eng-pod/shogo-system.yaml'), 'utf-8')
}

export function configFromEnv(env: Record<string, string | undefined>, argv: string[]): SeedConfig {
  const workspaceId = env.WORKSPACE_ID
  if (!workspaceId) throw new Error('WORKSPACE_ID is required')
  const installation = env.GITHUB_INSTALLATION_ID ? Number(env.GITHUB_INSTALLATION_ID) : undefined
  if (env.GITHUB_INSTALLATION_ID && !Number.isInteger(installation)) throw new Error('GITHUB_INSTALLATION_ID must be a number')
  if (env.GITHUB_TEST_REPO && !/^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_TEST_REPO)) {
    throw new Error(`GITHUB_TEST_REPO must look like "<owner>/<repo>", got "${env.GITHUB_TEST_REPO}"`)
  }
  return {
    workspaceId,
    githubRepo: env.GITHUB_TEST_REPO,
    githubInstallationId: installation,
    coordinatorProjectId: env.COORDINATOR_PROJECT_ID,
    briefingCron: env.BRIEFING_CRON || DEFAULT_BRIEFING_CRON,
    briefingTimezone: env.BRIEFING_TIMEZONE || 'UTC',
    briefingPrompt: readBriefingPrompt(),
    manifestYaml: readManifestYaml(),
    maintainerUserIds: (env.MAINTAINER_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    flags: parseFlags(argv),
  }
}

const NAME_BY_ROLE = {
  coordinator: PROJECT_NAMES[COORDINATOR_KEY],
  builder: PROJECT_NAMES[BUILDER_KEY],
  reviewer: PROJECT_NAMES[REVIEWER_KEY],
} as const

export async function seedEngPod(config: SeedConfig, deps: SeedDeps): Promise<SeedResult> {
  const { api, log } = deps
  const ws = config.workspaceId
  const todo: string[] = []

  const listProjects = async () =>
    (await api<{ items?: Array<{ id: string; name: string }> }>('GET', `/projects?workspaceId=${encodeURIComponent(ws)}`)).items ?? []
  const findChannel = async () =>
    (await api<{ conversations: Array<{ id: string; name: string | null }> }>('GET', `/workspaces/${ws}/conversations`)).conversations.find(
      (c) => c.name === TEAM_CHANNEL,
    ) ?? null

  // 0. Fail early on a bad key or workspace.
  await findChannel()

  // 1. The coordinator is the one project made by hand; it creates the rest.
  let projects = await listProjects()
  let coordinator = config.coordinatorProjectId
    ? projects.find((p) => p.id === config.coordinatorProjectId)
    : projects.find((p) => p.name === NAME_BY_ROLE.coordinator)
  if (config.coordinatorProjectId && !coordinator) throw new Error(`COORDINATOR_PROJECT_ID ${config.coordinatorProjectId} is not in this workspace`)
  if (coordinator) {
    log(`coordinator: reusing "${coordinator.name}" (${coordinator.id})`)
  } else {
    const created = await api<{ data: { id: string; name: string } }>('POST', '/projects', {
      name: NAME_BY_ROLE.coordinator,
      workspaceId: ws,
      templateId: TEMPLATE_ID,
    })
    coordinator = created.data
    log(`coordinator: created "${coordinator.name}" (${coordinator.id}) from template ${TEMPLATE_ID}`)
  }

  // The manifest's channel includes @maintainers; system_apply leaves it as a manual step when the group is missing.
  const { groups } = await api<{ groups: Array<{ handle: string }> }>('GET', `/workspaces/${ws}/user-groups`)
  if (!groups.some((g) => g.handle === 'maintainers')) {
    await api('POST', `/workspaces/${ws}/user-groups`, {
      handle: 'maintainers',
      name: 'Maintainers',
      description: 'People who approve merges in #eng',
      memberIds: config.maintainerUserIds,
    })
    log(`group: created @maintainers with ${config.maintainerUserIds.length} members`)
    if (config.maintainerUserIds.length === 0) todo.push('Add people to the @maintainers group (or re-run with MAINTAINER_USER_IDS=id1,id2 after deleting it).')
  } else {
    log('group: @maintainers already exists')
  }

  // 2. The team: apply the manifest.
  let channel = await findChannel()
  projects = await listProjects()
  const have = (role: 'builder' | 'reviewer') => projects.some((p) => p.name === NAME_BY_ROLE[role])
  /** system_apply writes a new project's prompt files only once the project is reachable on disk, which can take a second run. */
  const roleWithoutPrompt = async () => {
    const missing: string[] = []
    for (const role of ['builder', 'reviewer'] as const) {
      const project = projects.find((p) => p.name === NAME_BY_ROLE[role])
      if (!project) continue
      const written = await api('GET', `/projects/${project.id}/files/AGENTS.md`).then(() => true, () => false)
      if (!written) missing.push(role)
    }
    return missing
  }
  const teamExists = () => !!channel && have('builder') && have('reviewer')

  // Always applied (it is idempotent): the coordinator's own prompt lives at its merged root, which the API cannot see from here.
  let missingPrompts: string[] = []
  if (deps.askCoordinator) {
    // A project made through the API gets the template's agent settings but not its files.
    await api('PUT', `/projects/${coordinator.id}/files/shogo-system.yaml`, { content: config.manifestYaml })
    log('team: wrote shogo-system.yaml to the coordinator')
    for (let attempt = 1; attempt <= MAX_APPLY_ATTEMPTS; attempt++) {
      log(`team: asking the coordinator to apply shogo-system.yaml, attempt ${attempt} (this can take a few minutes)`)
      const reply = await deps.askCoordinator(attempt === 1 ? APPLY_PROMPT : REAPPLY_PROMPT, coordinator.id)
      log(`team: coordinator replied: ${reply.replace(/\s+/g, ' ').slice(0, 300)}`)
      channel = await findChannel()
      projects = await listProjects()
      if (!teamExists()) {
        if (attempt === MAX_APPLY_ATTEMPTS) {
          throw new Error(`system_apply did not create #${TEAM_CHANNEL} and both projects; its reply is above. Fix that and re-run.`)
        }
        continue
      }
      missingPrompts = await roleWithoutPrompt()
      if (missingPrompts.length === 0) break
      log(`team: ${missingPrompts.join(' and ')} still has no AGENTS.md; applying again`)
    }
    if (missingPrompts.length > 0) {
      throw new Error(`system_apply did not write AGENTS.md for ${missingPrompts.join(' and ')}; re-run the seed.`)
    }
  } else {
    todo.push(
      `Open "${coordinator.name}" in Shogo (or set AGENT_URL to its runtime) and tell it: "${APPLY_PROMPT}". Then re-run this script.`,
    )
    log('team: no runtime to ask; cannot apply the manifest from here')
  }

  const projectIds: SeedResult['projectIds'] = { coordinator: coordinator.id }
  for (const role of ['builder', 'reviewer'] as const) {
    const found = projects.find((p) => p.name === NAME_BY_ROLE[role])
    if (found) projectIds[role] = found.id
  }

  // 3. A clean, buggy baseline (before connecting, so each project's checkout starts from it).
  if (config.flags.resetRepo) {
    if (!deps.resetRepo) throw new Error('--reset-repo needs GITHUB_TEST_REPO')
    await deps.resetRepo()
    log(`repo: reset ${config.githubRepo} to the checkout-app baseline`)
  }

  // 4. GitHub: each project talks to the same repo (connect is an upsert).
  if (config.githubRepo && config.githubInstallationId) {
    const [owner, repo] = config.githubRepo.split('/')
    for (const [role, id] of Object.entries(projectIds)) {
      await api('POST', `/projects/${id}/github/connect`, { installation_id: config.githubInstallationId, repo_owner: owner, repo_name: repo })
      log(`github: connected ${role} to ${config.githubRepo}`)
    }
  } else {
    todo.push('Connect the coordinator, builder and reviewer projects to the demo repo (set GITHUB_TEST_REPO and GITHUB_INSTALLATION_ID and re-run).')
  }

  // 5. The morning briefing, reporting into #eng.
  let scheduleId: string | null = null
  if (channel) {
    const { schedules } = await api<{ schedules: Array<{ id: string; name: string; notifyConversationId?: string | null; enabled: boolean }> }>(
      'GET',
      `/workspaces/${ws}/schedules`,
    )
    const existing = schedules.find((s) => s.name === BRIEFING_NAME)
    const wanted = {
      prompt: config.briefingPrompt,
      cronExpression: config.briefingCron,
      timezone: config.briefingTimezone,
      notifyConversationId: channel.id,
      enabled: true,
    }
    if (existing) {
      await api('PATCH', `/workspaces/${ws}/schedules/${existing.id}`, wanted)
      scheduleId = existing.id
      log(`briefing: updated "${BRIEFING_NAME}" (${config.briefingCron} ${config.briefingTimezone}) → #${TEAM_CHANNEL}`)
    } else {
      const created = await api<{ schedule: { id: string } }>('POST', `/workspaces/${ws}/schedules`, { name: BRIEFING_NAME, ...wanted })
      scheduleId = created.schedule.id
      log(`briefing: created "${BRIEFING_NAME}" (${config.briefingCron} ${config.briefingTimezone}) → #${TEAM_CHANNEL}`)
    }
    if (config.flags.runBriefing) {
      await api('POST', `/workspaces/${ws}/schedules/${scheduleId}/run`)
      log('briefing: queued to run now; it posts in #eng within about a minute')
    }
  }

  // 6. Slack bridge: same threads, both places.
  if (config.flags.slack) {
    await api('PATCH', `/workspaces/${ws}/chat-mode`, { mode: 'bridged', provider: 'slack' })
    log('slack: workspace chat is now bridged to Slack; #eng channels are adopted')
  }

  return { coordinatorProjectId: coordinator.id, channelId: channel?.id ?? null, projectIds, scheduleId, todo }
}

/** Collects the assistant's text from the runtime's SSE chat stream. */
export async function readReply(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'text-delta') text += event.delta ?? ''
        else if (event.type === 'error') text += `[error: ${event.errorText ?? event.error ?? 'unknown'}]`
      } catch {
        // keep-alives and [DONE]
      }
    }
  }
  return text
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const config = configFromEnv(process.env, process.argv.slice(2))
  const apiUrl = (process.env.SHOGO_API_URL || 'http://localhost:8002').replace(/\/$/, '')
  const key = process.env.SHOGO_API_KEY
  if (!key) throw new Error('SHOGO_API_KEY is required')

  const api: SeedDeps['api'] = async (method, path, body) => {
    const res = await fetch(`${apiUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
    return (await res.json().catch(() => ({}))) as any
  }

  const agentUrlOverride = process.env.AGENT_URL?.replace(/\/$/, '')
  const fixtureDir = resolve(process.env.FIXTURE_DIR || join(import.meta.dir, '../../e2e/issue-pipeline/fixtures/checkout-app'))
  const deps: SeedDeps = {
    api,
    log: (line) => console.log(line),
    // Defaults to the API's own agent proxy, which starts the coordinator's runtime when needed.
    askCoordinator: async (message, coordinatorProjectId) => {
      const agentUrl = agentUrlOverride ?? `${apiUrl}/api/projects/${coordinatorProjectId}/agent-proxy`
      const chatSessionId = `seed-eng-pod-${Date.now()}`
      const res = await fetch(`${agentUrl}/agent/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Session-Id': chatSessionId,
          ...(agentUrl.startsWith(apiUrl) ? { Authorization: `Bearer ${key}` } : {}),
          ...(process.env.AUTH_COOKIE ? { Cookie: process.env.AUTH_COOKIE } : {}),
        },
        body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: message }] }], chatSessionId }),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      })
      if (!res.ok) throw new Error(`coordinator runtime → ${res.status}: ${await res.text()}`)
      return readReply(res)
    },
    resetRepo: config.githubRepo
      ? async () => {
          const { resetFixtureRepo } = await import('../../e2e/issue-pipeline/helpers')
          await resetFixtureRepo({ githubTestRepo: config.githubRepo!, fixtureDir, pollMs: 0, timeoutMs: 0 })
          await closeOpenWork(config.githubRepo!)
        }
      : undefined,
  }

  const result = await seedEngPod(config, deps)
  console.log(`\nSeeded. Coordinator ${result.coordinatorProjectId}, #${TEAM_CHANNEL} ${result.channelId ?? '(not created yet)'}.`)
  if (result.todo.length) console.log(`\nStill to do:\n${result.todo.map((t) => `- ${t}`).join('\n')}`)
  else console.log('Next: post the bug in #eng (see docs/runbooks/eng-pod-demo.md).')
}

/**
 * Close the issues and pull requests earlier takes left open. The coordinator rightly refuses to file a
 * duplicate, so a repo that still tracks the coupon bug would stop the next take at triage.
 */
async function closeOpenWork(repo: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const gh = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile('gh', args, (err, stdout, stderr) => (err ? reject(new Error(`gh ${args.join(' ')}: ${stderr || err.message}`)) : resolve(stdout))),
    )
  for (const kind of ['issue', 'pr'] as const) {
    const listed = JSON.parse(await gh([kind, 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number']))
    for (const { number } of listed as Array<{ number: number }>) {
      await gh([kind, 'close', String(number), '--repo', repo, '--comment', 'Closed by the eng-pod demo reset.'])
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
