// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One chat as seen from the island. Exactly one client drives a session:
 *
 * - Mounted: a ChatPanel in a Shogo window has it open (it's in the
 *   snapshot). Every write goes over IPC to that panel; the island renders
 *   persisted history plus the panel's live reply preview.
 * - Owned: nobody has it open. The island runs its own `useChat` against the
 *   same transport ChatPanel uses, with durable resume.
 *
 * Switching between the two remounts the host (see IslandChatHost), so an
 * owned `useChat` is torn down as soon as a ChatPanel opens the session;
 * ChatPanel then re-attaches to any live turn through `/stream?fromSeq`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat, type UIMessage } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { appendQueuedUserMessage } from "../chat/queued-user-message"
import { buildChatTurnUrl, useChatTransportConfig } from "@shogo/shared-app/chat"
import {
  useChatMessageCollectionForSession,
  useDomainActions,
} from "@shogo/shared-app/domain"
import { API_URL, api, createHttpClient } from "../../lib/api"
import { buildChatSendBody, generateClientTurnId, type ChatSendInteractionMode } from "../../lib/chat-send-body"
import { buildStopRequest } from "../../lib/chat-stop"
import { resolveChatScope } from "../../lib/chat-scope"
import type { IslandPermissionDecision, IslandPlanSummary } from "../../lib/desktop-island"
import type { PlanData } from "../chat/PlanCard"
import { probeChatTurnStatus, shouldAttachLiveStream } from "../chat/probe-turn-status"
import { dropUnfinishedAssistantTail, withResumeReplayReset } from "../chat/resume-replay-transport"
import { derivePendingQuestion, type PendingQuestion } from "../chat/turns/pendingQuestion"
import { buildAskUserAnswerMessage } from "../chat/turns/askUserAnswers"
import { useServerMessageQueue } from "../chat/useServerMessageQueue"
import { derivePendingPlan } from "./island-inbox"
import type {
  IslandAttachment,
  IslandBridge,
  IslandFileRef,
  IslandResult,
  IslandSession,
} from "./types"

const HISTORY_PAGE_SIZE = 50
const MOUNTED_REFRESH_MS = 4000

export interface IslandPermission {
  id: string
  toolName: string
  category: string
  reason: string
  params: Record<string, unknown>
  paramsTruncated?: boolean
  timeout: number
  startedAt: number
}

export type IslandQuestion =
  /** Owned: the full ask_user tool call, answered with the real widget. */
  | { kind: "tool"; pending: PendingQuestion }
  /** Mounted: the snapshot's single-question summary. */
  | {
      kind: "summary"
      id: string
      prompt: string
      options: Array<{ label: string; description?: string }>
      answerInApp: boolean
    }

export interface IslandSendOptions {
  interactionMode?: ChatSendInteractionMode
  modelId?: string
}

export interface IslandChatSession {
  projectId: string
  sessionId: string
  owned: boolean
  messages: UIMessage[]
  isStreaming: boolean
  isLoading: boolean
  /** Live reply text from a mounted ChatPanel while its turn streams. */
  liveReply?: string
  step?: string
  permission: IslandPermission | null
  question: IslandQuestion | null
  plan: PlanData | IslandPlanSummary | null
  error: string | null
  send(text: string, files?: IslandFileRef[], options?: IslandSendOptions): Promise<IslandResult>
  stop(): Promise<IslandResult>
  respondPermission(decision: IslandPermissionDecision, pattern?: string): Promise<IslandResult>
  answerQuestion(response: string): Promise<IslandResult>
  buildPlan(modelId?: string): Promise<IslandResult>
  sendPlanFeedback(text: string): Promise<IslandResult>
}

export interface IslandSessionContext {
  bridge: IslandBridge
  projectId: string
  sessionId: string
  workspaceId?: string
  userId?: string
  /** Model for sends that don't pick one. */
  modelId: string
  interactionMode: ChatSendInteractionMode
}

const OK: IslandResult = { ok: true }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(error: unknown): IslandResult {
  return { ok: false, error: errorMessage(error) }
}

function toUIMessages(records: any[]): UIMessage[] {
  return [...records]
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((record) => {
      let parts: any[] | undefined
      if (record.parts) {
        try {
          parts = JSON.parse(record.parts)
        } catch {
          parts = undefined
        }
      }
      return {
        id: record.id,
        role: record.role,
        parts: parts ?? [{ type: "text", text: record.content ?? "" }],
      } as UIMessage
    })
}

function useSessionHistory(sessionId: string) {
  const collection = useChatMessageCollectionForSession(sessionId)
  const load = useCallback(async (): Promise<UIMessage[]> => {
    if (!collection) return []
    await collection.loadPage(
      { sessionId, agent: "technical" },
      { limit: HISTORY_PAGE_SIZE, offset: 0 },
    )
    return toUIMessages(collection.all as any[])
  }, [collection, sessionId])
  return { collection, load }
}

async function resolveAttachments(
  bridge: IslandBridge,
  files: IslandFileRef[] | undefined,
): Promise<IslandAttachment[]> {
  if (!files?.length) return []
  const result = await bridge.readFiles(files)
  if (!result.ok) throw new Error(result.error)
  return result.attachments
}

// ── Mounted: a ChatPanel owns the session ──────────────────────────────────

export function useMountedIslandSession(
  ctx: IslandSessionContext,
  live: IslandSession,
): IslandChatSession {
  const { bridge, projectId, sessionId } = ctx
  const { load } = useSessionHistory(sessionId)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isStreaming = live.status === "running"

  const refresh = useCallback(() => {
    load()
      .then((next) => setMessages(next))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setIsLoading(false))
  }, [load])

  useEffect(refresh, [refresh, live.status, live.pending?.request.id])
  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(refresh, MOUNTED_REFRESH_MS)
    return () => clearInterval(timer)
  }, [isStreaming, refresh])

  const run = useCallback(
    async (action: Parameters<IslandBridge["sendAction"]>[0]) => {
      setError(null)
      const result = await bridge.sendAction(action)
      if (!result.ok) setError(result.error)
      return result
    },
    [bridge],
  )

  const pending = live.pending
  const permission: IslandPermission | null =
    pending?.kind === "permission" ? { ...pending.request } : null
  const question: IslandQuestion | null =
    pending?.kind === "question" ? { kind: "summary", ...pending.request } : null

  return {
    projectId,
    sessionId,
    owned: false,
    messages,
    isStreaming,
    isLoading,
    liveReply: isStreaming ? live.replyPreview : undefined,
    step: live.step,
    permission,
    question,
    plan: live.pendingPlan ?? null,
    error,
    send: (text, files) =>
      run({ type: "send", target: { kind: "session", projectId, sessionId }, text, ...(files?.length ? { files } : {}) }),
    stop: () => run({ type: "stop", projectId, sessionId }),
    respondPermission: (decision, pattern) =>
      permission
        ? run({ type: "permission", requestId: permission.id, decision, ...(pattern ? { pattern } : {}) })
        : Promise.resolve(OK),
    answerQuestion: (response) =>
      pending?.kind === "question"
        ? run({ type: "question", requestId: pending.request.id, response })
        : Promise.resolve(OK),
    buildPlan: (modelId) =>
      run({ type: "plan", projectId, sessionId, decision: "build", ...(modelId ? { modelId } : {}) }),
    sendPlanFeedback: (text) => run({ type: "plan", projectId, sessionId, decision: "feedback", text }),
  }
}

// ── Owned: no ChatPanel has it open ────────────────────────────────────────

export function useOwnedIslandSession(
  ctx: IslandSessionContext,
  initialSend?: { text: string; files?: IslandFileRef[]; attachments?: IslandAttachment[] } | null,
): IslandChatSession {
  const { bridge, projectId, sessionId, workspaceId, userId, modelId, interactionMode } = ctx
  const actions = useDomainActions()
  const { collection, load } = useSessionHistory(sessionId)
  const chatWorkspaceId =
    resolveChatScope({ surface: "project-tab", isInitialSession: false, requestedScope: "project" }) ===
      "workspace" && workspaceId
      ? workspaceId
      : undefined

  const clientTurnIdRef = useRef<string | undefined>(undefined)
  const getClientTurnId = useCallback(() => clientTurnIdRef.current, [])
  const transportConfig = useChatTransportConfig({
    apiBaseUrl: API_URL!,
    projectId,
    workspaceId: chatWorkspaceId,
    credentials: "include",
    chatSessionId: sessionId,
    getClientTurnId,
  })
  const beforeReplayRef = useRef<() => void>(() => {})
  const transport = useMemo(
    () =>
      transportConfig
        ? withResumeReplayReset(new DefaultChatTransport(transportConfig), () => beforeReplayRef.current())
        : undefined,
    [transportConfig],
  )

  const [permission, setPermission] = useState<IslandPermission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const { messages, sendMessage, status, setMessages, stop, resumeStream } = useChat({
    transport,
    id: sessionId,
    resume: false,
    experimental_throttle: 120,
    onData: (part: any) => {
      if (part?.type !== "data-permission-request" || !part.data) return
      const req = part.data
      setPermission({
        id: req.id,
        toolName: req.toolName ?? "",
        category: req.category ?? "",
        reason: req.reason ?? "",
        params: req.params ?? {},
        timeout: req.timeout ?? 60,
        startedAt: Date.now(),
      })
    },
    onError: (err) => setError(err.message || "Connection interrupted"),
    onFinish: () => setPermission(null),
  })
  beforeReplayRef.current = () => setMessages((prev) => dropUnfinishedAssistantTail(prev))
  const isStreaming = status === "submitted" || status === "streaming"

  const resume = useCallback(() => {
    void resumeStream().catch(() => undefined)
  }, [resumeStream])
  const resumeQueuedTurn = useCallback(
    (queuedUserMessage?: UIMessage) => {
      if (queuedUserMessage) setMessages((prev) => appendQueuedUserMessage(prev, queuedUserMessage))
      resume()
    },
    [resume, setMessages],
  )
  const serverQueue = useServerMessageQueue({
    sessionId,
    enabled: true,
    isStreaming,
    onTurnAvailable: resumeQueuedTurn,
  })

  useEffect(() => {
    let cancelled = false
    load()
      .then(async (history) => {
        if (cancelled) return
        setMessages(history)
        const turnStatus = await probeChatTurnStatus({
          url: buildChatTurnUrl(API_URL!, projectId, null, sessionId, chatWorkspaceId),
          credentials: "include",
        })
        if (!cancelled && shouldAttachLiveStream(turnStatus)) resume()
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setIsLoading(false))
    return () => {
      cancelled = true
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Yielding to a ChatPanel only detaches this client; the turn keeps running
  // server-side and the panel resumes it.
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => () => void stopRef.current(), [])

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming

  const sendAttachments = useCallback(
    async (
      text: string,
      attachments: IslandAttachment[],
      options: IslandSendOptions & { confirmedPlan?: PlanData | null } = {},
    ): Promise<IslandResult> => {
      const content = text.trim()
      if (!content && attachments.length === 0) return OK
      setError(null)
      const clientTurnId = generateClientTurnId()
      const body = buildChatSendBody({
        featureId: projectId,
        phase: null,
        chatSessionId: sessionId,
        workspaceId,
        userId,
        projectId,
        agentMode: options.modelId || modelId,
        interactionMode: options.interactionMode ?? interactionMode,
        clientTurnId,
        confirmedPlan: options.confirmedPlan,
      })
      const fileParts = attachments.map((file) => ({
        type: "file" as const,
        mediaType: file.type || "application/octet-stream",
        url: file.dataUrl,
        ...(file.name ? { name: file.name } : {}),
      }))
      try {
        if (isStreamingRef.current) {
          await serverQueue.enqueue({
            content,
            files: attachments,
            selectedModel: options.modelId || modelId,
            body: { ...body, text: content },
          })
          return OK
        }
        const parts = [...(content ? [{ type: "text", text: content }] : []), ...fileParts]
        actions
          .addMessage({ sessionId, role: "user", content, parts: JSON.stringify(parts) })
          .catch((err: unknown) => console.warn("[Island] Failed to persist user message:", err))
        clientTurnIdRef.current = clientTurnId
        await sendMessage({ text: content, ...(fileParts.length ? { files: fileParts } : {}) }, { body })
        return OK
      } catch (err) {
        setError(errorMessage(err))
        return fail(err)
      }
    },
    [actions, interactionMode, modelId, projectId, sendMessage, serverQueue, sessionId, userId, workspaceId],
  )

  const send = useCallback(
    async (text: string, files?: IslandFileRef[], options?: IslandSendOptions) => {
      try {
        return await sendAttachments(text, await resolveAttachments(bridge, files), options)
      } catch (err) {
        setError(errorMessage(err))
        return fail(err)
      }
    },
    [bridge, sendAttachments],
  )

  const initialSentRef = useRef(false)
  useEffect(() => {
    if (!initialSend || initialSentRef.current || isLoading) return
    initialSentRef.current = true
    if (initialSend.attachments) {
      void sendAttachments(initialSend.text, initialSend.attachments)
    } else {
      void send(initialSend.text, initialSend.files)
    }
  }, [initialSend, isLoading, send, sendAttachments])

  const stopTurn = useCallback(async () => {
    stop()
    const req = buildStopRequest({
      localAgentUrl: null,
      projectId,
      workspaceId: chatWorkspaceId,
      apiBaseUrl: API_URL!,
      platform: "web",
      chatSessionId: sessionId,
    })
    if (!req) return OK
    try {
      await fetch(req.url, req.init)
      return OK
    } catch (err) {
      return fail(err)
    }
  }, [chatWorkspaceId, projectId, sessionId, stop])

  const respondPermission = useCallback(
    async (decision: IslandPermissionDecision, pattern?: string) => {
      if (!permission) return OK
      const id = permission.id
      setPermission(null)
      try {
        await api.sendPermissionResponse(createHttpClient(), projectId, {
          id,
          decision,
          ...(pattern ? { pattern } : {}),
        })
        return OK
      } catch (err) {
        return fail(err)
      }
    },
    [permission, projectId],
  )

  const pendingQuestion = useMemo(() => derivePendingQuestion(messages), [messages])

  const answerQuestion = useCallback(
    async (response: string) => {
      const pending = derivePendingQuestion(messagesRef.current)
      if (!pending) return OK
      const result = await sendAttachments(buildAskUserAnswerMessage(pending.tool.id, response), [])
      const target = messagesRef.current.find((message) => message.id === pending.messageId)
      if (target) {
        const parts = (target.parts as any[]).map((part) =>
          part.type === "dynamic-tool" && part.toolCallId === pending.tool.id
            ? { ...part, output: response, state: "output-available" }
            : part,
        )
        setMessages((prev) =>
          prev.map((message) => (message.id === pending.messageId ? ({ ...message, parts } as UIMessage) : message)),
        )
        ;(collection as any)
          ?.update?.(pending.messageId, { parts: JSON.stringify(parts) })
          ?.catch?.((err: unknown) => console.warn("[Island] Failed to persist ask_user output:", err))
      }
      return result
    },
    [collection, sendAttachments, setMessages],
  )

  const plan = useMemo(() => (isStreaming ? null : derivePendingPlan(messages)), [isStreaming, messages])

  const buildPlan = useCallback(
    (buildModelId?: string) =>
      plan
        ? sendAttachments("Execute the confirmed plan.", [], {
            modelId: buildModelId,
            confirmedPlan: plan,
            interactionMode: "agent",
          })
        : Promise.resolve(OK),
    [plan, sendAttachments],
  )

  const sendPlanFeedback = useCallback(
    (text: string) => sendAttachments(text, [], { interactionMode: "plan" }),
    [sendAttachments],
  )

  return {
    projectId,
    sessionId,
    owned: true,
    messages,
    isStreaming,
    isLoading,
    permission,
    question: pendingQuestion ? { kind: "tool", pending: pendingQuestion } : null,
    plan,
    error,
    send,
    stop: stopTurn,
    respondPermission,
    answerQuestion,
    buildPlan,
    sendPlanFeedback,
  }
}
