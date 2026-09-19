// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono, type Context } from 'hono'
import { prisma } from '../lib/prisma'
import type { NotificationType } from '../lib/prisma'
import { projectChatRoutes } from './project-chat'
import { createNotification } from '../services/notification.service'
import { sendPushToUser } from '../lib/push-notifications'
import { homeRegionWorkspaceWhere } from '../lib/region'

type RuntimeManager = Parameters<typeof projectChatRoutes>[0]['runtimeManager']
export type AgentTaskRuntimeManager = RuntimeManager
const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

const TASK_STATUSES = new Set(['draft', 'queued', 'running', 'completed', 'failed', 'cancelled'])
const runningTaskControllers = new Map<string, AbortController>()

// Agent work is persisted in the database, but the runtime stream itself is
// process-local. The dispatcher keeps queued work moving after an API restart
// and marks abandoned running work as retryable instead of leaving Activity
// stuck forever.
const TASK_HEARTBEAT_INTERVAL_MS = 10_000
const TASK_STALE_AFTER_MS = 60_000

type TaskWithProject = {
  id: string
  userId: string
  workspaceId: string
  projectId: string | null
  chatSessionId: string | null
  title: string
  notes: string | null
  dueAt: Date | null
  status: string
  currentStep: string | null
  resultSummary: string | null
  errorMessage: string | null
  queuedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  project?: { name: string | null } | null
}

async function stopTaskRuntime(
  task: { id: string; projectId: string | null; chatSessionId: string | null },
  runtimeManager?: RuntimeManager,
): Promise<void> {
  if (!task.projectId || !task.chatSessionId) return

  try {
    const response = await projectChatRoutes({ runtimeManager }).fetch(
      new Request(`http://internal/projects/${task.projectId}/chat/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatSessionId: task.chatSessionId }),
        signal: AbortSignal.timeout(10_000),
      }),
    )
    if (!response.ok) {
      throw new Error(`Runtime stop returned HTTP ${response.status}`)
    }
  } catch (error) {
    // The durable cancelled state is authoritative. Log a failed best-effort
    // stop so it can be retried/diagnosed without turning cancellation into a
    // request failure for the user.
    console.error(`[AgentTask] Failed to stop runtime for ${task.id}:`, error)
  }
}

function watchForTaskCancellation(
  task: { id: string; projectId: string; chatSessionId: string },
  abortController: AbortController,
  runtimeManager?: RuntimeManager,
): () => void {
  let stopped = false
  let interval: ReturnType<typeof setInterval> | null = null
  const stop = () => {
    stopped = true
    if (interval) clearInterval(interval)
    interval = null
  }
  const check = async () => {
    if (stopped) return
    try {
      const latest = await prisma.agentTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      })
      // A deleted task is also a cancellation: the worker has no remaining
      // owner for this runtime turn.
      if (latest && latest.status !== 'cancelled') return
      stop()
      abortController.abort()
      await stopTaskRuntime(task, runtimeManager)
    } catch (error) {
      // A transient DB read failure must not turn into an unsolicited stop.
      // The next interval retries the durable-state check.
      console.error(`[AgentTask] Failed to check cancellation for ${task.id}:`, error)
    }
  }
  interval = setInterval(() => void check(), 2_000)
  return stop
}

function authUserId(c: Context): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated === false ? null : auth?.userId ?? null
}

function unauthorized(c: Context) {
  return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function taskView(task: TaskWithProject) {
  return {
    id: task.id,
    userId: task.userId,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    projectName: task.project?.name ?? null,
    chatSessionId: task.chatSessionId,
    title: task.title,
    notes: task.notes,
    dueAt: task.dueAt,
    status: task.status,
    currentStep: task.currentStep,
    resultSummary: task.resultSummary,
    errorMessage: task.errorMessage,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

async function loadTask(id: string, userId: string) {
  return prisma.agentTask.findFirst({
    where: { id, userId },
    include: { project: { select: { id: true, name: true } } },
  })
}

async function notifyTask(
  task: {
    id: string
    userId: string
    title: string
    projectId: string | null
    chatSessionId: string | null
  },
  type: Extract<NotificationType, `agent_task_${string}`>,
  message: string,
) {
  await createNotification({
    userId: task.userId,
    type,
    title: task.title,
    message,
    metadata: { taskId: task.id, projectId: task.projectId },
    actionUrl: `/tasks?taskId=${encodeURIComponent(task.id)}`,
    dedupeKey: `${task.id}:${type}`,
  })

  // The in-app row is only visible while the app is running. Completion and
  // failure must also reach a backgrounded/closed mobile app, where the
  // project chat screen (and its local-notification hook) is unmounted. Task
  // start is intentionally kept in the in-app Activity feed; only actionable
  // terminal states produce an OS notification.
  if (type !== 'agent_task_started') {
    await sendPushToUser(task.userId, {
      title: task.title,
      body: message,
      data: {
        taskId: task.id,
        sessionId: task.chatSessionId,
        projectId: task.projectId,
        notificationType: type,
        actionUrl: `/tasks?taskId=${encodeURIComponent(task.id)}`,
      },
    })
  }
}

async function consumeResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let message = body || `Agent request failed with HTTP ${response.status}`
    try {
      const payload = JSON.parse(body)
      message = payload?.error?.message || payload?.message || message
    } catch {
      // Keep the raw response when it is not JSON.
    }
    throw new Error(message)
  }
  if (!response.body) return
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
    }
  } finally {
    reader.releaseLock()
  }
}

async function waitForAssistantMessage(
  sessionId: string,
  promptMessageId: string,
  afterCreatedAt: Date,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs

  while (true) {
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId, role: { in: ['assistant', 'user'] }, createdAt: { gt: afterCreatedAt } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true },
    })

    const firstMessage = messages[0]
    if (firstMessage?.role === 'user' && firstMessage.id !== promptMessageId) {
      throw new Error('Another chat message started before the delegated task completed. Retry the task to keep its result associated with the correct chat turn.')
    }
    if (firstMessage?.role === 'assistant') return firstMessage
    if (Date.now() >= deadline) return null

    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function startTaskHeartbeat(taskId: string): () => void {
  const heartbeat = setInterval(() => {
    void prisma.agentTask.updateMany({
      where: { id: taskId, status: 'running' },
      data: { updatedAt: new Date() },
    }).catch((error) => {
      console.error(`[AgentTask] Failed to heartbeat ${taskId}:`, error)
    })
  }, TASK_HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(heartbeat)
}

function buildAgentTaskPrompt(task: { title: string; notes: string | null }) {
  return [
    `This is a delegated task from the user's task list: ${task.title}`,
    task.notes?.trim() ? `\nAdditional notes:\n${task.notes.trim()}` : '',
    '\nWork on this task thoroughly and return a concise summary of what you completed, what remains, and any links or next steps.',
  ].join('')
}

async function persistAgentTaskPrompt(
  sessionId: string,
  task: { title: string; notes: string | null },
) {
  const prompt = buildAgentTaskPrompt(task)
  const parts = [{ type: 'text', text: prompt }]
  const created = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: 'user',
      content: prompt,
      parts: JSON.stringify(parts),
      agent: 'technical',
    },
    select: { id: true, createdAt: true },
  })

  return { prompt, parts, promptMessageId: created.id, afterCreatedAt: created.createdAt }
}

type TaskRouting = {
  projectId: string
  sessionId: string
}

/**
 * Every started task runs in a project chat. A task created without a
 * project gets a real project here; `Home` is a UI context, not a project.
 */
async function ensureProjectChat(task: {
  id: string
  userId: string
  workspaceId: string
  projectId: string | null
  chatSessionId: string | null
  title: string
  notes: string | null
}) {
  let projectId = task.projectId

  if (!projectId) {
    const project = await prisma.project.create({
      data: {
        name: task.title.slice(0, 120),
        description: task.notes?.trim() || null,
        workspaceId: task.workspaceId,
        createdBy: task.userId,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
        schemas: (isLocalMode ? '[]' : []) as any,
        settings: isLocalMode
          ? JSON.stringify({ activeMode: 'canvas', techStackId: 'react-app' })
          : { activeMode: 'canvas', techStackId: 'react-app' },
      },
      select: { id: true },
    })
    projectId = project.id
  }

  let sessionId = task.chatSessionId
  if (sessionId) {
    const existingSession = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { contextType: true, contextId: true },
    })
    if (existingSession?.contextType !== 'project' || existingSession.contextId !== projectId) {
      sessionId = null
    }
  }

  if (!sessionId) {
    const session = await prisma.chatSession.create({
      data: {
        inferredName: task.title.slice(0, 120),
        contextType: 'project',
        contextId: projectId,
      },
      select: { id: true },
    })
    sessionId = session.id
  }

  const routedTask = await prisma.agentTask.update({
    where: { id: task.id },
    data: { projectId, chatSessionId: sessionId },
    include: { project: { select: { id: true, name: true } } },
  })

  return { projectId, sessionId, task: routedTask }
}

async function runAgentTask(
  taskId: string,
  runtimeManager?: RuntimeManager,
  preparedRouting?: TaskRouting,
) {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId } })
  if (!task || task.status === 'cancelled') return
  if (task.dueAt && task.dueAt.getTime() > Date.now()) return

  let sessionId = task.chatSessionId
  let abortController: AbortController | null = null
  let stopCancellationWatch: (() => void) | null = null
  let stopHeartbeat: (() => void) | null = null
  try {
    const started = await prisma.agentTask.updateMany({
      where: { id: taskId, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), currentStep: 'Starting the agent' },
    })
    if (started.count === 0) return
    abortController = new AbortController()
    runningTaskControllers.set(taskId, abortController)
    stopHeartbeat = startTaskHeartbeat(taskId)

    // A cancellation may land after the queued -> running claim but before
    // this process registers its controller. The DB is the cross-instance
    // source of truth, so re-check it before any side effect or runtime call.
    const current = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } })
    if (current?.status !== 'running') return

    await prisma.agentTask.update({
      where: { id: taskId },
      data: { currentStep: task.projectId ? 'Preparing the project agent' : 'Creating a project for this task' },
    })
    const routed = preparedRouting
      ? { ...preparedRouting, task }
      : await ensureProjectChat(task)
    sessionId = routed.sessionId
    const routedTask = preparedRouting
      ? { ...task, projectId: preparedRouting.projectId }
      : routed.task

    const promptState = await persistAgentTaskPrompt(sessionId, task)
    const { parts } = promptState
    const body = JSON.stringify({
      messages: [{ role: 'user', parts }],
      chatSessionId: sessionId,
      userId: task.userId,
      // Let the runtime's Auto router choose from the server-provided model
      // map. This is especially important in local mode, where the map points
      // at the configured Ollama model instead of a cloud Claude id.
      agentMode: 'auto',
      interactionMode: 'agent',
      // A retry is a new delegated execution, not a transport retry of the
      // previous execution. Give it a fresh idempotency key.
      clientTurnId: `agent-task-${task.id}-${crypto.randomUUID()}`,
    })

    await prisma.agentTask.update({
      where: { id: taskId },
      data: { currentStep: 'Working in the project agent' },
    })
    const beforeDispatch = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } })
    if (beforeDispatch?.status !== 'running') return
    await notifyTask(
      routedTask,
      'agent_task_started',
      'The project agent has started working.',
    )

    const router = projectChatRoutes({ runtimeManager, suppressCompletionPush: true })
    stopCancellationWatch = watchForTaskCancellation(
      { id: taskId, projectId: routed.projectId, chatSessionId: sessionId },
      abortController,
      runtimeManager,
    )
    const response = await router.fetch(
      new Request(`http://internal/projects/${routed.projectId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Task-Id': taskId,
          'X-Chat-Session-Id': sessionId,
          'X-Billing-User-Id': task.userId,
        },
        body,
        signal: abortController.signal,
      }),
    )
    await consumeResponse(response)

    const latest = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } })
    if (latest?.status === 'cancelled') return

    const assistant = await waitForAssistantMessage(
      sessionId,
      promptState.promptMessageId,
      promptState.afterCreatedAt,
    )
    if (!assistant) {
      throw new Error('The agent did not return a response. Check the project runtime and model configuration, then retry.')
    }
    const summary = assistant?.content?.trim() || 'The agent completed the task.'
    const completedAt = new Date()
    const completedUpdate = await prisma.agentTask.updateMany({
      where: { id: taskId, status: 'running' },
      data: {
        status: 'completed',
        currentStep: null,
        resultSummary: summary.slice(0, 8_000),
        completedAt,
      },
    })
    if (completedUpdate.count === 0) return
    const completed = await prisma.agentTask.findUnique({ where: { id: taskId } })
    if (completed) await notifyTask(completed, 'agent_task_completed', 'The agent completed this task.')
  } catch (error: unknown) {
    const message = errorMessage(error, 'The agent could not complete this task.')
    const latest = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } }).catch(() => null)
    if (latest?.status === 'cancelled') return
    const failed = await prisma.agentTask.update({
      where: { id: taskId },
      data: { status: 'failed', currentStep: null, errorMessage: message.slice(0, 2_000) },
    }).catch(() => null)
    if (failed) await notifyTask(failed, 'agent_task_failed', message.slice(0, 500))
    console.error(`[AgentTask] ${taskId} failed:`, message)
  } finally {
    stopCancellationWatch?.()
    stopHeartbeat?.()
    if (abortController && runningTaskControllers.get(taskId) === abortController) {
      runningTaskControllers.delete(taskId)
    }
  }
}

export async function dispatchQueuedTasks(runtimeManager?: RuntimeManager): Promise<void> {
  const now = new Date()
  const staleBefore = new Date(now.getTime() - TASK_STALE_AFTER_MS)
  const homeFilter = homeRegionWorkspaceWhere()
  const workspaceFilter = homeFilter ? { workspace: homeFilter } : {}

  // A live worker refreshes updatedAt. A task that has not been refreshed for
  // the lease window was interrupted by a crashed/restarted API process. Mark
  // it failed so the user can retry it explicitly; silently replaying the
  // prompt could create duplicate work in the project chat. In multi-region
  // mode, each replica only touches tasks owned by its workspace's home
  // region, so logical replication cannot produce duplicate execution.
  const abandoned = await prisma.agentTask.updateMany({
    where: { status: 'running', updatedAt: { lt: staleBefore }, ...workspaceFilter },
    data: {
      status: 'failed',
      currentStep: null,
      errorMessage: 'The agent process stopped before this task completed. Retry the task to continue.',
    },
  })
  if (abandoned.count > 0) {
    console.warn(`[AgentTask] Marked ${abandoned.count} abandoned task(s) as retryable`)
  }

  const queued = await prisma.agentTask.findMany({
    where: {
      status: 'queued',
      OR: [{ dueAt: null }, { dueAt: { lte: now } }],
      ...workspaceFilter,
    },
    orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
    take: 10,
    select: { id: true },
  })

  for (const task of queued) {
    // runAgentTask performs the atomic queued -> running claim, so multiple
    // API instances can safely observe the same queue without duplicating work.
    void runAgentTask(task.id, runtimeManager)
  }
}

export function createAgentTaskRoutes(config: { runtimeManager?: RuntimeManager } = {}) {
  const router = new Hono()

  router.get('/agent-tasks', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)
    const status = c.req.query('status')
    const projectId = c.req.query('projectId')
    const tasks = await prisma.agentTask.findMany({
      where: {
        userId,
        ...(status && TASK_STATUSES.has(status) ? { status: status as any } : {}),
        ...(projectId ? { projectId } : {}),
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })
    return c.json({ ok: true, items: tasks.map(taskView) })
  })

  router.post('/agent-tasks', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)
    const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null
    if (!title || title.length > 500 || !workspaceId) {
      return c.json({ error: { code: 'bad_request', message: 'title and workspaceId are required' } }, 400)
    }
    const member = await prisma.member.findFirst({ where: { userId, workspaceId }, select: { id: true } })
    if (!member) return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    if (projectId) {
      const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } })
      if (!project) return c.json({ error: { code: 'bad_request', message: 'Invalid project for workspace' } }, 400)
    }
    const dueAt = typeof body.dueAt === 'string' && body.dueAt ? new Date(body.dueAt) : null
    if (dueAt && Number.isNaN(dueAt.getTime())) return c.json({ error: { code: 'bad_request', message: 'Invalid dueAt' } }, 400)
    const task = await prisma.agentTask.create({
      data: {
        userId,
        workspaceId,
        projectId,
        title,
        notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 10_000) : null,
        dueAt,
      },
      include: { project: { select: { id: true, name: true } } },
    })
    return c.json({ ok: true, data: taskView(task) }, 201)
  })

  router.post('/agent-tasks/:id/start', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)
    const task = await loadTask(c.req.param('id'), userId)
    if (!task) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    if (task.status === 'queued' || task.status === 'running') return c.json({ ok: true, data: taskView(task) })
    if (task.status === 'completed' || task.status === 'cancelled') {
      return c.json({ error: { code: 'conflict', message: 'This task cannot be started again' } }, 409)
    }
    const member = await prisma.member.findFirst({
      where: { userId, workspaceId: task.workspaceId },
      select: { id: true },
    })
    if (!member) return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    if (task.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: task.projectId, workspaceId: task.workspaceId },
        select: { id: true },
      })
      if (!project) return c.json({ error: { code: 'conflict', message: 'Task project is no longer available' } }, 409)
    }
    // Claim the task before creating a project/session so two rapid Start
    // Agent taps cannot create duplicate project chats or workers.
    const claim = await prisma.agentTask.updateMany({
      where: { id: task.id, userId, status: { in: ['draft', 'failed'] } },
      data: { status: 'queued', queuedAt: new Date(), errorMessage: null },
    })
    if (claim.count === 0) {
      const current = await loadTask(task.id, userId)
      if (current?.status === 'queued' || current?.status === 'running') {
        return c.json({ ok: true, data: taskView(current) })
      }
      return c.json({ error: { code: 'conflict', message: 'This task cannot be started again' } }, 409)
    }

    const claimedTask = await loadTask(task.id, userId)
    if (!claimedTask) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)

    let routed: Awaited<ReturnType<typeof ensureProjectChat>>
    try {
      // Resolve the destination before responding so the client can open the
      // exact project chat immediately after Start Agent is tapped.
      routed = await ensureProjectChat(claimedTask)
    } catch (error: unknown) {
      const message = errorMessage(error, 'Could not prepare the project chat')
      await prisma.agentTask.update({
        where: { id: claimedTask.id },
        data: { status: 'failed', errorMessage: message.slice(0, 2_000) },
      }).catch(() => {})
      return c.json({ error: { code: 'task_prepare_failed', message } }, 500)
    }
    const finalize = await prisma.agentTask.updateMany({
      where: { id: claimedTask.id, status: 'queued' },
      data: { projectId: routed.projectId, chatSessionId: routed.sessionId },
    })
    const queued = await loadTask(claimedTask.id, userId)
    if (!queued) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    if (finalize.count === 0) return c.json({ ok: true, data: taskView(queued) })
    const dueAt = queued.dueAt ? new Date(queued.dueAt) : null
    if (!dueAt || dueAt.getTime() <= Date.now()) {
      void runAgentTask(queued.id, config.runtimeManager, {
        projectId: routed.projectId,
        sessionId: routed.sessionId,
      })
    }
    return c.json({ ok: true, data: taskView(queued) }, 202)
  })

  router.post('/agent-tasks/:id/cancel', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)
    const task = await loadTask(c.req.param('id'), userId)
    if (!task) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
      return c.json({ ok: true, data: taskView(task) })
    }
    const cancellation = await prisma.agentTask.updateMany({
      where: { id: task.id, status: { in: ['draft', 'queued', 'running'] } },
      data: { status: 'cancelled', currentStep: null },
    })
    if (cancellation.count > 0) {
      runningTaskControllers.get(task.id)?.abort()
      await stopTaskRuntime(task, config.runtimeManager)
    }
    const cancelled = await loadTask(task.id, userId)
    if (!cancelled) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    if (cancellation.count === 0) return c.json({ ok: true, data: taskView(cancelled) })
    return c.json({ ok: true, data: taskView(cancelled) })
  })

  router.patch('/agent-tasks/:id', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)
    const task = await loadTask(c.req.param('id'), userId)
    if (!task) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>
    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 500)
    if (typeof body.notes === 'string') data.notes = body.notes.trim().slice(0, 10_000)
    if (body.dueAt === null) data.dueAt = null
    else if (typeof body.dueAt === 'string') {
      const dueAt = new Date(body.dueAt)
      if (Number.isNaN(dueAt.getTime())) return c.json({ error: { code: 'bad_request', message: 'Invalid dueAt' } }, 400)
      data.dueAt = dueAt
    }
    const updated = await prisma.agentTask.update({
      where: { id: task.id },
      data,
      include: { project: { select: { id: true, name: true } } },
    })
    return c.json({ ok: true, data: taskView(updated) })
  })

  router.delete('/agent-tasks/:id', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)
    const task = await loadTask(c.req.param('id'), userId)
    if (!task) return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404)
    const cancellation = await prisma.agentTask.updateMany({
      where: { id: task.id, userId, status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled', currentStep: null },
    })
    if (cancellation.count > 0) {
      runningTaskControllers.get(task.id)?.abort()
      await stopTaskRuntime(task, config.runtimeManager)
    }
    await prisma.agentTask.delete({ where: { id: task.id } })
    return c.json({ ok: true })
  })

  return router
}
