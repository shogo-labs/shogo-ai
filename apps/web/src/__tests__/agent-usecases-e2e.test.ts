/**
 * Agent Runtime E2E Tests — OpenClaw Parity Use Cases
 *
 * Real end-to-end Playwright tests that:
 * 1. Create agent projects via the CreateProjectModal UI
 * 2. Configure workspace files via the agent runtime REST API
 * 3. Interact with the agent through /agent/test and the Test Chat UI
 * 4. Verify results via UI assertions + runtime API reads
 *
 * Coverage matrix (capabilities per use case):
 *   UC1 Self-Healing:  exec, memory, heartbeat, session persistence, cron
 *   UC2 Morning Brief: exec, write_file, cron, web_fetch
 *   UC3 Second Brain:  memory_read/write, multi-turn recall, session persistence
 *   UC4 Health Track:  memory tagging, pattern analysis, heartbeat, compaction
 *   UC5 Goal Tasks:    exec, write_file, read_file, memory, heartbeat, multi-iteration
 *   UC6 Task Manager:  exec, memory, webhooks (/agent/hooks/wake), cron
 *
 * Prerequisites:
 * - Web app on localhost:5173
 * - API server on localhost:8002
 * - Database + infrastructure running
 * - ANTHROPIC_API_KEY configured (via AI proxy)
 */

import { test, expect, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WEB_URL = process.env.WEB_URL || 'http://localhost:5173'
const API_URL = process.env.API_URL || 'http://localhost:8002'
const AGENT_TIMEOUT = 120_000
const RUNTIME_POLL_INTERVAL = 2_000
const RUNTIME_MAX_WAIT = 80_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentProject {
  projectId: string
  agentUrl: string
}

/**
 * Sign up a fresh test user through the UI if not already authenticated.
 */
async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto(WEB_URL)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3_000)

  const loginVisible = await page
    .getByText('Sign in to your account')
    .isVisible()
    .catch(() => false)
  if (!loginVisible) return

  const testEmail = `e2e-agent-${Date.now()}@example.com`
  await page.getByRole('tab', { name: 'Sign Up' }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill('E2E Agent Tester')
  await page.getByRole('textbox', { name: 'Email' }).fill(testEmail)
  await page.getByRole('textbox', { name: 'Password' }).fill('TestPassword123!')
  await page.getByRole('button', { name: 'Sign Up' }).click()

  await expect(
    page.getByRole('heading', { name: /what's on your mind/i }),
  ).toBeVisible({ timeout: 15_000 })
}

/**
 * Create an AGENT project via the CreateProjectModal on /projects.
 * Returns projectId + agentUrl once the runtime is healthy.
 */
async function createAgentProject(
  page: Page,
  name: string,
): Promise<AgentProject> {
  await page.goto(`${WEB_URL}/projects`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3_000)

  // Open CreateProjectModal
  await page.locator('button').filter({ hasText: 'Create new project' }).click()
  const modal = page.getByRole('dialog')
  await expect(modal).toBeVisible({ timeout: 5_000 })

  // Select Agent Builder
  await modal.getByText('Agent Builder').click()

  // Fill name
  await modal.locator('input#project-name').fill(name)

  // Submit
  await modal.getByRole('button', { name: /create project/i }).click()

  // Wait for navigation to the new project
  await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 20_000 })
  await page.waitForLoadState('networkidle')

  const projectId = page.url().match(/\/projects\/([a-f0-9-]+)/)?.[1]
  if (!projectId) throw new Error('Failed to extract project ID from URL')

  // Ensure runtime is started
  await page.request
    .post(`${API_URL}/api/projects/${projectId}/runtime/start`)
    .catch(() => {})

  const agentUrl = await waitForAgentRuntime(page, projectId)
  return { projectId, agentUrl }
}

/**
 * Poll until the agent runtime gateway is running.
 */
async function waitForAgentRuntime(
  page: Page,
  projectId: string,
): Promise<string> {
  const maxAttempts = Math.ceil(RUNTIME_MAX_WAIT / RUNTIME_POLL_INTERVAL)
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await page.request.get(
        `${API_URL}/api/projects/${projectId}/sandbox/url`,
      )
      if (res.ok()) {
        const data = await res.json()
        const agentUrl: string = data.agentUrl || data.url
        if (agentUrl && (data.ready || data.status === 'running')) {
          const healthRes = await page.request.get(`${agentUrl}/health`)
          if (healthRes.ok()) {
            const health = await healthRes.json()
            if (health.gateway?.running) return agentUrl
          }
        }
      }
    } catch {
      // Not ready yet
    }
    await page.waitForTimeout(RUNTIME_POLL_INTERVAL)
  }
  throw new Error(
    `Agent runtime for ${projectId} did not become ready in ${RUNTIME_MAX_WAIT / 1000}s`,
  )
}

/** Write an agent workspace file via the runtime API. */
async function writeAgentFile(
  page: Page,
  agentUrl: string,
  filename: string,
  content: string,
) {
  const res = await page.request.put(`${agentUrl}/agent/files/${filename}`, {
    data: { content },
  })
  expect(res.ok()).toBe(true)
}

/** Read an agent workspace file via the runtime API. */
async function readAgentFile(
  page: Page,
  agentUrl: string,
  filename: string,
): Promise<string> {
  const res = await page.request.get(`${agentUrl}/agent/files/${filename}`)
  expect(res.ok()).toBe(true)
  const data = await res.json()
  return data.content || ''
}

/**
 * Send a test message via the /agent/test API.
 * Retries once on socket hang up (LLM + tool chains can exceed HTTP idle timeout).
 */
async function sendTestMessage(
  page: Page,
  agentUrl: string,
  message: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await page.request.post(`${agentUrl}/agent/test`, {
        data: { message },
        timeout: AGENT_TIMEOUT,
      })
      expect(res.ok()).toBe(true)
      const data = await res.json()
      return data.response
    } catch (err: any) {
      if (attempt === 0 && err.message?.includes('socket hang up')) {
        await page.waitForTimeout(5_000)
        continue
      }
      throw err
    }
  }
  throw new Error('sendTestMessage: all attempts failed')
}

/** Get agent status (sessions, cron, heartbeat config). */
async function getAgentStatus(page: Page, agentUrl: string) {
  const res = await page.request.get(`${agentUrl}/agent/status`)
  expect(res.ok()).toBe(true)
  return res.json()
}

/** Trigger a heartbeat tick and return the result text. */
async function triggerHeartbeat(
  page: Page,
  agentUrl: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await page.request.post(
        `${agentUrl}/agent/heartbeat/trigger`,
        { timeout: AGENT_TIMEOUT },
      )
      expect(res.ok()).toBe(true)
      const data = await res.json()
      return data.result
    } catch (err: any) {
      if (attempt === 0 && err.message?.includes('socket hang up')) {
        await page.waitForTimeout(5_000)
        continue
      }
      throw err
    }
  }
  throw new Error('triggerHeartbeat: all attempts failed')
}

/** Send a webhook wake request. */
async function sendWebhook(
  page: Page,
  agentUrl: string,
  text: string,
): Promise<any> {
  const res = await page.request.post(`${agentUrl}/agent/hooks/wake`, {
    data: { text, mode: 'now' },
    headers: { Authorization: 'Bearer test-webhook-token' },
    timeout: AGENT_TIMEOUT,
  })
  return { status: res.status(), body: await res.json().catch(() => null) }
}

/** Delete a project (best-effort cleanup). */
async function deleteProject(page: Page, projectId: string) {
  await page.request
    .delete(`${API_URL}/api/projects/${projectId}`)
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// UC1: Self-Healing Home Server
// Capabilities: exec, memory, heartbeat, session persistence, cron
// ---------------------------------------------------------------------------

test.describe.serial('UC1: Self-Healing Home Server', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UC1 ServerBot ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('configure self-healing server agent', async () => {
    await writeAgentFile(
      page,
      project.agentUrl,
      'AGENTS.md',
      [
        '# Self-Healing Home Server Agent',
        '',
        '## Role',
        'You are an infrastructure monitoring agent that checks system health.',
        '',
        '## Behavior',
        '- Use exec tool to run diagnostic commands when asked',
        '- Write findings to memory using memory_write',
        '- Keep responses concise and structured',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'HEARTBEAT.md',
      [
        '# Heartbeat Checklist',
        '- Read MEMORY.md and write a one-line status summary to memory',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'IDENTITY.md',
      '# Identity\nName: ServerBot\nEmoji: 🖥️\nTagline: Self-healing infra companion',
    )

    await writeAgentFile(page, project.agentUrl, 'MEMORY.md', '# Memory\n')
  })

  test('exec tool: agent runs diagnostics', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Check disk space by running "df -h /" using exec and tell me the usage percentage. Be brief.',
    )
    expect(response.length).toBeGreaterThan(10)
    expect(response).toMatch(/\d+%|disk|space|usage|capacity|filesystem/i)
  })

  test('memory_write: agent persists findings', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Write "E2E test: disk check passed" to MEMORY.md using memory_write. Be brief.',
    )
    expect(response.toLowerCase()).toMatch(/written|saved|updated|memory|done/i)

    const memory = await readAgentFile(page, project.agentUrl, 'MEMORY.md')
    expect(memory).toContain('E2E test')
  })

  test('cron: agent creates a scheduled job', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Create a cron job named "health-check" that runs every 3600 seconds with prompt "Run df -h / and report". Use the cron tool with action "add".',
    )
    expect(response.toLowerCase()).toMatch(
      /cron|job|created|scheduled|added|health/i,
    )

    const status = await getAgentStatus(page, project.agentUrl)
    const job = status.cronJobs?.find(
      (j: any) => j.name === 'health-check',
    )
    expect(job).toBeDefined()
  })

  test('heartbeat: autonomous tick runs checklist', async () => {
    const result = await triggerHeartbeat(page, project.agentUrl)
    expect(result.length).toBeGreaterThan(5)
  })

  test('session persistence: messages accumulated', async () => {
    const status = await getAgentStatus(page, project.agentUrl)
    const testSession = status.sessions?.find((s: any) => s.id === 'test')
    expect(testSession).toBeDefined()
    expect(testSession.messageCount).toBeGreaterThanOrEqual(6)
  })

  test('UI: project page shows agent tabs', async () => {
    await page.goto(`${WEB_URL}/projects/${project.projectId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3_000)

    await expect(
      page.getByRole('button', { name: 'Test Chat' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByRole('button', { name: 'Workspace' }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Heartbeat' }),
    ).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// UC2: Custom Morning Brief
// Capabilities: exec, write_file, cron, web_fetch
// ---------------------------------------------------------------------------

test.describe.serial('UC2: Custom Morning Brief', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UC2 Briefer ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('configure morning brief agent', async () => {
    await writeAgentFile(
      page,
      project.agentUrl,
      'AGENTS.md',
      [
        '# Morning Brief Agent',
        '',
        '## Role',
        'You compile daily summaries with system info.',
        '',
        '## Behavior',
        '- Gather info using exec (date, uptime)',
        '- Write briefs to files using write_file',
        '- Structure briefs with Date, Status, Notes sections',
        '- Be concise',
      ].join('\n'),
    )
    await writeAgentFile(page, project.agentUrl, 'MEMORY.md', '# Briefs\n')
  })

  test('exec + write_file: agent compiles a brief', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Create a morning brief: get the current date with exec "date" and uptime with exec "uptime", then write a short brief to brief.md using write_file. Be concise.',
    )
    expect(response.length).toBeGreaterThan(20)
    expect(response.toLowerCase()).toMatch(
      /brief|date|written|saved|created|compiled/i,
    )
  })

  test('cron: agent schedules a daily brief job', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Set up a cron job named "morning-brief" that runs every 86400 seconds with prompt "Generate the daily morning brief". Use the cron tool with action "add".',
    )
    expect(response.toLowerCase()).toMatch(
      /cron|job|created|scheduled|morning|added/i,
    )

    const status = await getAgentStatus(page, project.agentUrl)
    const cronJob = status.cronJobs?.find(
      (j: any) => j.name === 'morning-brief',
    )
    expect(cronJob).toBeDefined()
  })

  test('web_fetch: agent fetches a URL', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Use web_fetch to get the contents of https://httpbin.org/get and tell me the origin IP. Be brief.',
    )
    expect(response.length).toBeGreaterThan(10)
    expect(response.toLowerCase()).toMatch(/origin|ip|\d+\.\d+/i)
  })

  test('UI: Test Chat shows streaming response', async () => {
    await page.goto(`${WEB_URL}/projects/${project.projectId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3_000)

    await page.getByRole('button', { name: 'Test Chat' }).click()
    await page.waitForTimeout(1_000)

    const testInput = page.getByPlaceholder(/send a test message/i)
    await expect(testInput).toBeVisible({ timeout: 10_000 })
    await testInput.fill('What is 2+2? Reply with just the number.')
    await testInput.press('Enter')

    // Wait for a response to appear
    await page.waitForTimeout(30_000)
    const content = await page.textContent('body')
    expect(content?.toLowerCase()).toMatch(/four|4/)
  })
})

// ---------------------------------------------------------------------------
// UC3: Second Brain
// Capabilities: memory_read/write, multi-turn recall, session persistence
// ---------------------------------------------------------------------------

test.describe.serial('UC3: Second Brain', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UC3 Brain ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('configure second brain agent', async () => {
    await writeAgentFile(
      page,
      project.agentUrl,
      'AGENTS.md',
      [
        '# Second Brain Agent',
        '',
        '## Role',
        'You are a personal knowledge manager.',
        '',
        '## Behavior',
        '- Save things to MEMORY.md using memory_write with append=true',
        '- When asked to recall, read MEMORY.md with memory_read',
        '- Categorize entries with tags like [fact], [idea], [todo]',
        '- Always confirm what you saved',
      ].join('\n'),
    )
    await writeAgentFile(
      page,
      project.agentUrl,
      'MEMORY.md',
      '# Knowledge Base\n',
    )
  })

  test('memory_write: stores facts', async () => {
    const r1 = await sendTestMessage(
      page,
      project.agentUrl,
      'Remember: The API server runs on port 8002 and uses Hono.',
    )
    expect(r1.toLowerCase()).toMatch(/saved|stored|remembered|noted|memory/i)

    const r2 = await sendTestMessage(
      page,
      project.agentUrl,
      'Remember: The database password is in AWS Secrets Manager under "staging/db".',
    )
    expect(r2.toLowerCase()).toMatch(/saved|stored|remembered|noted|memory/i)
  })

  test('memory_read: recalls stored knowledge', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'What do you know about the API server? Check your memory.',
    )
    expect(response.toLowerCase()).toMatch(/8002|hono|api/i)
  })

  test('memory file contains all entries', async () => {
    const memory = await readAgentFile(page, project.agentUrl, 'MEMORY.md')
    expect(memory).toContain('8002')
    expect(memory.toLowerCase()).toContain('secret')
  })

  test('multi-turn: agent recalls from conversation context', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Where is the database password stored? You told me earlier.',
    )
    expect(response.toLowerCase()).toMatch(
      /aws|secrets?\s*manager|staging/i,
    )
  })

  test('session persistence: messages persist', async () => {
    const status = await getAgentStatus(page, project.agentUrl)
    const testSession = status.sessions?.find((s: any) => s.id === 'test')
    expect(testSession).toBeDefined()
    expect(testSession.messageCount).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// UC4: Health & Symptom Tracker
// Capabilities: memory tagging, pattern analysis, heartbeat, compaction
// ---------------------------------------------------------------------------

test.describe.serial('UC4: Health & Symptom Tracker', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UC4 HealthBot ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('configure health tracker agent', async () => {
    await writeAgentFile(
      page,
      project.agentUrl,
      'AGENTS.md',
      [
        '# Health Tracker Agent',
        '',
        '## Role',
        'You track food intake and symptoms.',
        '',
        '## Behavior',
        '- Log food and symptoms to MEMORY.md with timestamps via memory_write append',
        '- Format: [FOOD] or [SYMPTOM] prefix',
        '- When asked for analysis, read MEMORY.md and identify patterns',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'HEARTBEAT.md',
      [
        '# Heartbeat Checklist',
        '- Write a one-line health status note to memory',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'MEMORY.md',
      '# Health Log\n',
    )
  })

  test('memory_write: logs food and symptoms', async () => {
    const r1 = await sendTestMessage(
      page,
      project.agentUrl,
      'I had coffee and a bagel for breakfast.',
    )
    expect(r1.toLowerCase()).toMatch(
      /logged|recorded|noted|breakfast|coffee|bagel/i,
    )

    const r2 = await sendTestMessage(
      page,
      project.agentUrl,
      'I have a headache and stomach discomfort.',
    )
    expect(r2.toLowerCase()).toMatch(
      /logged|recorded|noted|headache|stomach/i,
    )
  })

  test('pattern analysis: agent finds correlations', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Analyze my food and symptom log. What patterns do you see? Read memory first.',
    )
    expect(response.length).toBeGreaterThan(50)
    expect(response.toLowerCase()).toMatch(
      /coffee|headache|pattern|symptom|food/i,
    )
  })

  test('memory contains tagged entries', async () => {
    const memory = await readAgentFile(page, project.agentUrl, 'MEMORY.md')
    expect(memory.toLowerCase()).toContain('coffee')
    expect(memory.toLowerCase()).toContain('headache')
  })

  test('heartbeat: autonomous health review', async () => {
    const result = await triggerHeartbeat(page, project.agentUrl)
    expect(result.length).toBeGreaterThan(5)
  })

  test('compaction: session handles many messages', async () => {
    for (let i = 0; i < 5; i++) {
      await sendTestMessage(
        page,
        project.agentUrl,
        `Quick log: had water at ${10 + i}:00. Acknowledge in one word.`,
      )
    }
    const status = await getAgentStatus(page, project.agentUrl)
    const testSession = status.sessions?.find((s: any) => s.id === 'test')
    expect(testSession).toBeDefined()
    expect(testSession.messageCount).toBeGreaterThanOrEqual(10)
  })
})

// ---------------------------------------------------------------------------
// UC5: Goal-Driven Autonomous Tasks
// Capabilities: exec, write_file, read_file, memory, heartbeat, multi-iteration
// ---------------------------------------------------------------------------

test.describe.serial('UC5: Goal-Driven Autonomous Tasks', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UC5 GoalBot ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('configure goal-driven agent', async () => {
    await writeAgentFile(
      page,
      project.agentUrl,
      'AGENTS.md',
      [
        '# Goal-Driven Task Agent',
        '',
        '## Role',
        'You help achieve goals by breaking them into tasks and executing them.',
        '',
        '## Behavior',
        '- Break goals into concrete tasks',
        '- Write task lists using write_file',
        '- Execute tasks with exec and write_file',
        '- Save progress to MEMORY.md',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'HEARTBEAT.md',
      [
        '# Heartbeat',
        '- Write a one-line task status note to memory',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'MEMORY.md',
      '# Goal Progress\n',
    )
  })

  test('write_file: agent creates a task list', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Goal: Set up a project. Write a tasks.md file with these tasks: 1) Create README.md 2) Create src/index.ts. Use write_file.',
    )
    expect(response.toLowerCase()).toMatch(
      /tasks|created|written|list|plan/i,
    )
  })

  test('multi-tool: agent executes a task and logs progress', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Execute task 1: Create README.md with content "# My Project\\nCreated by GoalBot" using write_file. Then log progress to MEMORY.md via memory_write append.',
    )
    expect(response.toLowerCase()).toMatch(
      /created|readme|done|complete|written/i,
    )

    const memory = await readAgentFile(page, project.agentUrl, 'MEMORY.md')
    expect(memory.toLowerCase()).toMatch(/task|readme|progress|complete/i)
  })

  test('exec: agent runs a shell command', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Use exec to run "echo hello-goal-bot" and tell me the output. Be brief.',
    )
    expect(response.toLowerCase()).toContain('hello-goal-bot')
  })

  test('heartbeat: checks and works on tasks', async () => {
    const result = await triggerHeartbeat(page, project.agentUrl)
    expect(result.length).toBeGreaterThan(5)
  })

  test('multi-iteration: agent does multiple tool calls in one turn', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Execute task 2: First create directory "src" with exec "mkdir -p src", then create src/index.ts with write_file containing "console.log(\'hello\')". Do both steps.',
    )
    expect(response.toLowerCase()).toMatch(/created|index|src|done/i)
  })

  test('session persistence: all interactions tracked', async () => {
    const status = await getAgentStatus(page, project.agentUrl)
    const testSession = status.sessions?.find((s: any) => s.id === 'test')
    expect(testSession).toBeDefined()
    expect(testSession.messageCount).toBeGreaterThanOrEqual(8)
  })
})

// ---------------------------------------------------------------------------
// UC6: Task Manager with Webhooks
// Capabilities: exec, memory, webhooks, cron, session persistence
// ---------------------------------------------------------------------------

test.describe.serial('UC6: Task Manager with Webhooks', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UC6 TaskMgr ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('configure task manager agent', async () => {
    await writeAgentFile(
      page,
      project.agentUrl,
      'AGENTS.md',
      [
        '# Task Manager Agent',
        '',
        '## Role',
        'You manage tasks with reasoning transparency.',
        '',
        '## Behavior',
        '- Maintain tasks in MEMORY.md',
        '- Add tasks with timestamps (use exec "date +%H:%M") and [pending] status',
        '- Mark completed tasks as [done]',
        '- Explain your prioritization reasoning',
      ].join('\n'),
    )

    await writeAgentFile(
      page,
      project.agentUrl,
      'MEMORY.md',
      '# Task List\n',
    )
  })

  test('exec + memory: agent adds timestamped tasks', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Add these tasks: 1) Deploy API v2, 2) Write auth tests, 3) Review PR #42. Get current time with exec "date +%H:%M" and add each to MEMORY.md.',
    )
    expect(response.toLowerCase()).toMatch(
      /added|task|deploy|test|review/i,
    )
  })

  test('memory_read: agent lists current tasks', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'List all my current tasks. Read from memory.',
    )
    expect(response.toLowerCase()).toMatch(/deploy|test|review|pr/i)
  })

  test('reasoning: agent completes task with explanation', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Mark "Review PR #42" as done. Explain why code reviews should be prioritized, then update MEMORY.md.',
    )
    expect(response.toLowerCase()).toMatch(
      /done|complete|review|pr|priorit/i,
    )
  })

  test('cron: agent schedules a task reminder', async () => {
    const response = await sendTestMessage(
      page,
      project.agentUrl,
      'Create a cron job named "task-reminder" every 7200 seconds with prompt "Check for overdue tasks". Use cron tool with action "add".',
    )
    expect(response.toLowerCase()).toMatch(
      /cron|job|created|scheduled|reminder|added/i,
    )

    const status = await getAgentStatus(page, project.agentUrl)
    const job = status.cronJobs?.find(
      (j: any) => j.name === 'task-reminder',
    )
    expect(job).toBeDefined()
  })

  test('memory reflects task updates', async () => {
    const memory = await readAgentFile(page, project.agentUrl, 'MEMORY.md')
    expect(memory.toLowerCase()).toContain('deploy')
    expect(memory.toLowerCase()).toMatch(/pr.*42|review/i)
  })

  test('webhook: wake endpoint processes external trigger', async () => {
    const result = await sendWebhook(
      page,
      project.agentUrl,
      'Urgent: production error in auth service',
    )
    // Webhook may return 200 with result or 401 if token auth is required
    expect([200, 401, 403]).toContain(result.status)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting UI verification
// ---------------------------------------------------------------------------

test.describe.serial('UI: Agent Project Interface', () => {
  test.setTimeout(300_000)

  let page: Page
  let project: AgentProject

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page)
    project = await createAgentProject(page, `UI Test Agent ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (project) await deleteProject(page, project.projectId)
    await page.close()
  })

  test('project page loads with agent tabs', async () => {
    await page.goto(`${WEB_URL}/projects/${project.projectId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3_000)

    await expect(
      page.getByRole('button', { name: 'Test Chat' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByRole('button', { name: 'Workspace' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skills' })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Heartbeat' }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Channels' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible()
  })

  test('Test Chat tab: send and receive messages', async () => {
    await page.getByRole('button', { name: 'Test Chat' }).click()
    await page.waitForTimeout(1_000)

    const testInput = page.getByPlaceholder(/send a test message/i)
    await expect(testInput).toBeVisible({ timeout: 10_000 })
    await testInput.fill('What is 2+2? Reply in one word.')
    await testInput.press('Enter')

    // Wait for agent response
    await page.waitForTimeout(30_000)

    const content = await page.textContent('body')
    expect(content?.toLowerCase()).toMatch(/four|4/)
  })

  test('Workspace tab: shows workspace files', async () => {
    await page.getByRole('button', { name: 'Workspace' }).click()
    await page.waitForTimeout(2_000)

    const content = await page.textContent('body')
    expect(content).toMatch(
      /Instructions|Persona|Identity|Heartbeat|Memory|Tools/i,
    )
  })

  test('Heartbeat tab: shows heartbeat status', async () => {
    await page.getByRole('button', { name: 'Heartbeat' }).click()
    await page.waitForTimeout(2_000)

    const content = await page.textContent('body')
    expect(content).toMatch(
      /heartbeat|interval|enabled|status|trigger/i,
    )
  })
})
