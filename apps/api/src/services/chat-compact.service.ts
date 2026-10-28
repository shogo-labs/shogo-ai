// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Summarize now" for both chat scopes (SHO-230).
 *
 * The context-usage dock's button used to reach only
 * `POST /projects/:projectId/chat/compact`. A workspace-scoped chat lives on
 * the *workspace* runtime, so that call landed on a runtime that had never
 * heard of the session, took the "evicted" branch, and folded the whole
 * ChatMessage history with sequential LLM calls inline in the request — on a
 * 192k-token chat that is minutes of a spinning button.
 *
 * Both routes now run this one function against the runtime that actually owns
 * the session, and the DB fold can no longer hold a request open: it is raced
 * against a budget, deduped per session, and finishes detached when it loses.
 */
import { prisma } from '../lib/prisma'
import { summarizeSessionFromDb } from './chat-history-seed.service'

export interface CompactionRowData {
  trigger: 'auto' | 'manual'
  tokensBefore: number
  tokensAfter: number
  messagesBefore: number
  messagesAfter: number
  summaryChars: number
}

/**
 * Write the transcript row for a compaction that happened with no live turn to
 * carry the SSE frame (the dock's manual button on an idle session).
 *
 * The part shape is identical to what `trackUsageFromStream` persists for an
 * auto compaction, so the divider renders the same way whether it came from a
 * turn or from the button.
 */
export async function persistCompactionRow(
  chatSessionId: string,
  data: CompactionRowData,
  logTag = '[ProjectChat]',
): Promise<void> {
  try {
    const session = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
    if (!session) return
    await prisma.chatMessage.create({
      data: {
        sessionId: chatSessionId,
        role: 'assistant',
        content: '',
        parts: JSON.stringify([{ type: 'data-context-summarized', data }]),
        agent: 'technical',
        model: 'auto',
      },
    })
  } catch (err: any) {
    console.warn(`${logTag} Failed to persist compaction row:`, err?.message ?? err)
  }
}

/**
 * How long a compact request waits on the DB fold before answering 202 and
 * letting it finish in the background. A long chat folds in sequential LLM
 * calls; the button must not be held open for that.
 */
export const COMPACT_DB_FOLD_BUDGET_MS = 20_000

export const COMPACT_STILL_SUMMARIZING =
  'Summarizing in the background — this can take a minute on a long chat'

type DbFold = {
  summary: string
  through: number
  messagesBefore: number
  messagesAfter: number
} | null

/**
 * Folds currently running, keyed by session. A second press while one is in
 * flight answers `queued` instead of starting a second fold over the same
 * history — two concurrent folds would double-bill the summarizer and race
 * each other's watermark write.
 */
const foldsInFlight = new Map<string, Promise<DbFold>>()

/** Test seam: the registry is module state and would otherwise leak between cases. */
export function resetCompactFoldsForTests(): void {
  foldsInFlight.clear()
}

function startDbFold(chatSessionId: string, logTag: string): Promise<DbFold> {
  const running = foldsInFlight.get(chatSessionId)
  if (running) return running

  const fold: Promise<DbFold> = summarizeSessionFromDb(chatSessionId)
    .then(async (fromDb) => {
      if (fromDb) {
        await persistCompactionRow(
          chatSessionId,
          {
            trigger: 'manual',
            tokensBefore: 0,
            tokensAfter: 0,
            messagesBefore: fromDb.messagesBefore,
            messagesAfter: fromDb.messagesAfter,
            summaryChars: fromDb.summary.length,
          },
          logTag,
        )
      }
      console.log(
        `${logTag} compact ${chatSessionId}: db fold finished (${
          fromDb ? `${fromDb.messagesBefore}→${fromDb.messagesAfter} messages` : 'nothing to fold'
        })`,
      )
      return fromDb
    })
    .catch((error: any) => {
      console.warn(`${logTag} compact ${chatSessionId}: db fold failed:`, error?.message ?? error)
      return null
    })

  foldsInFlight.set(chatSessionId, fold)
  void fold.finally(() => {
    if (foldsInFlight.get(chatSessionId) === fold) foldsInFlight.delete(chatSessionId)
  })
  return fold
}

/** Resolves `null` if `promise` has not settled within `budgetMs`. */
function raceBudget<T>(promise: Promise<T>, budgetMs: number): Promise<{ value: T } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), budgetMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ value })
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

export interface CompactChatSessionArgs {
  chatSessionId: string
  /**
   * Fetch against the runtime that owns the session — `fetchFromRuntime` for a
   * project chat, `fetchFromWorkspaceRuntime` for a workspace chat.
   */
  fetchRuntime: (path: string, init?: RequestInit) => Promise<Response>
  /** Router tag for the one info line each request writes (`[ProjectChat]`, `[WorkspaceChat]`). */
  logTag: string
  signal?: AbortSignal
  /** Override the DB-fold budget (tests). */
  dbFoldBudgetMs?: number
}

export interface CompactChatSessionResult {
  body: Record<string, unknown>
  status: number
}

type Outcome = 'compacted' | 'queued' | 'nothing' | 'db' | 'error'

interface RunResult {
  body: Record<string, unknown>
  status: number
  outcome: Outcome
}

function queuedResult(): RunResult {
  return {
    body: {
      compacted: false,
      queued: true,
      status: 'summarizing',
      reason: COMPACT_STILL_SUMMARIZING,
    },
    status: 202,
    outcome: 'queued',
  }
}

/**
 * Summarize one chat now.
 *
 * Runtime compact → evicted/404 → DB fold → persist row. A live turn answers
 * `queued` (the row lands with the assistant message at the next step), an
 * evicted session is folded from ChatMessage, and a fold that outlives the
 * budget answers 202 `summarizing` while it finishes detached.
 *
 * Always surfaces the runtime's own `reason` — a fake success would make the
 * dock's ring and the transcript disagree.
 */
export async function compactChatSession(
  args: CompactChatSessionArgs,
): Promise<CompactChatSessionResult> {
  const { chatSessionId, fetchRuntime, logTag, signal } = args
  const budgetMs = args.dbFoldBudgetMs ?? COMPACT_DB_FOLD_BUDGET_MS
  const startedAt = Date.now()

  const run = async (): Promise<RunResult> => {
    let response: Response
    try {
      response = await fetchRuntime(`/agent/sessions/${encodeURIComponent(chatSessionId)}/compact`, {
        method: 'POST',
        body: '{}',
        signal,
      })
    } catch (error: any) {
      return {
        body: { compacted: false, queued: false, reason: error?.message ?? 'compact failed' },
        status: 502,
        outcome: 'error',
      }
    }

    const result: any = await response.json().catch(() => ({}))
    // An idle or evicted session is the normal case here, not an error: the
    // runtime holds nothing in memory, so `compactSession()` answers
    // `unknown-session`, which the runtime turns into HTTP 404 with
    // `{reason: "session not found"}`. The rows are all in ChatMessage, so
    // summarize them API-side and store the block on the ChatSession
    // (SHO-137 round 3, R5). This branch has to come BEFORE `!response.ok`,
    // or the 404 returns first and the button is dead on exactly the chats
    // that need it most (round 4, B1).
    const evicted =
      response.status === 404 ||
      result?.status === 'unknown-session' ||
      result?.error === 'unknown-session' ||
      result?.reason === 'session not found'
    if (evicted) {
      // A fold already running for this session answers immediately: waiting
      // out another budget would just be the same spinner twice.
      if (foldsInFlight.has(chatSessionId)) return queuedResult()

      const settled = await raceBudget(startDbFold(chatSessionId, logTag), budgetMs)
      if (!settled) return queuedResult()
      const fromDb = settled.value
      if (!fromDb) {
        return {
          body: {
            compacted: false,
            queued: false,
            status: 'nothing-to-compact',
            reason: 'no stored messages to summarize',
          },
          status: 200,
          outcome: 'nothing',
        }
      }
      return {
        body: {
          compacted: true,
          queued: false,
          status: 'compacted',
          source: 'db',
          messagesBefore: fromDb.messagesBefore,
          messagesAfter: fromDb.messagesAfter,
          summaryChars: fromDb.summary.length,
        },
        status: 200,
        outcome: 'db',
      }
    }

    if (!response.ok) {
      return {
        body: {
          compacted: false,
          queued: false,
          reason: result?.error ?? result?.reason ?? `runtime ${response.status}`,
        },
        status: response.status,
        outcome: 'error',
      }
    }

    if (result?.compacted) {
      await persistCompactionRow(
        chatSessionId,
        {
          trigger: 'manual',
          tokensBefore: Number(result.tokensBefore) || 0,
          tokensAfter: Number(result.tokensAfter) || 0,
          messagesBefore: Number(result.messagesBefore) || 0,
          messagesAfter: Number(result.messagesAfter) || 0,
          summaryChars: Number(result.summaryChars) || 0,
        },
        logTag,
      )
      return { body: result, status: response.status, outcome: 'compacted' }
    }

    return {
      body: result,
      status: response.status,
      outcome: result?.queued ? 'queued' : 'nothing',
    }
  }

  const { body, status, outcome } = await run()
  console.log(`${logTag} compact ${chatSessionId}: ${outcome} in ${Date.now() - startedAt}ms`)
  return { body, status }
}
