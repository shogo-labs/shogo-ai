// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface SlackApiClient {
  call(method: string, body: Record<string, unknown>): Promise<any>
}

export interface SlackStreamWriterOptions {
  client: SlackApiClient
  channelId: string
  threadTs: string
  recipientUserId?: string
  recipientTeamId?: string
  flushChars?: number
  now?: () => number
}

type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'error'

interface SlackTask {
  id: string
  title: string
  status: TaskStatus
}

/**
 * Converts the UI-message events emitted by project-chat.ts into Slack's
 * Agent streaming protocol. Keeping this as a small stateful adapter makes it
 * independently testable and keeps Slack formatting out of the agent loop.
 */
export class SlackStreamWriter {
  private readonly client: SlackApiClient
  private readonly channelId: string
  private readonly threadTs: string
  private readonly recipientUserId?: string
  private readonly recipientTeamId?: string
  private readonly flushChars: number
  private readonly now: () => number
  private streamTs: string | null = null
  private text = ''
  private tasks = new Map<string, SlackTask>()
  private lastFlushAt = 0
  private stopped = false
  /**
   * Number of `text-start` events seen so far. The gateway closes the
   * current text block (`text-end`) before every tool call and opens a new
   * one (`text-start`) once the model resumes talking — e.g. "Let me mount
   * the COUNTER project." / [mount_project runs] / "Mounted! ...". Those are
   * two separate segments with no natural separator in the raw deltas, so
   * without tracking this we'd concatenate them into one run-on sentence
   * like "project.Mounted!". Every text-start after the first inserts a
   * paragraph break before the new segment's deltas.
   */
  private textSegments = 0

  constructor(options: SlackStreamWriterOptions) {
    this.client = options.client
    this.channelId = options.channelId
    this.threadTs = options.threadTs
    this.recipientUserId = options.recipientUserId
    this.recipientTeamId = options.recipientTeamId
    this.flushChars = options.flushChars ?? 120
    this.now = options.now ?? Date.now
  }

  get messageTs(): string | null {
    return this.streamTs
  }

  async write(chunk: Record<string, any>): Promise<void> {
    if (this.stopped) return
    const type = chunk.type

    if (type === 'text-start') {
      this.textSegments++
      // Not the first segment in this turn — a tool call (or other
      // boundary) separated it from whatever text came before, so start it
      // on a new paragraph instead of running it into the prior sentence.
      if (this.textSegments > 1) this.text += '\n\n'
      return
    }

    if (type === 'text-delta' && typeof chunk.delta === 'string') {
      this.text += chunk.delta
      if (this.text.length >= this.flushChars || this.now() - this.lastFlushAt >= 750) {
      await this.flushText()
      }
      return
    }

    if (type === 'tool-input-start' || type === 'tool-call-start') {
      const id = String(chunk.toolCallId || `tool-${this.tasks.size + 1}`)
      const title = formatToolTitle(
        String(chunk.toolName || chunk.name || 'Working'),
        chunk.input || chunk.args || chunk.parameters,
      )
      this.tasks.set(id, { id, title, status: 'in_progress' })
      await this.appendTasks([this.tasks.get(id)!])
      // Keep the "is thinking..." shimmer (set by dispatchSlackMessage
      // before the writer even exists) current with what's actually
      // happening, instead of it going stale the moment tool use starts.
      await this.setThreadStatus(`is using ${title}…`)
      return
    }

    if (type === 'tool-input-available') {
      const id = String(chunk.toolCallId || `tool-${this.tasks.size + 1}`)
      if (!this.tasks.has(id)) {
        this.tasks.set(id, {
          id,
          title: formatToolTitle(String(chunk.toolName || 'Working'), chunk.input || chunk.args),
          status: 'in_progress',
        })
        await this.appendTasks([this.tasks.get(id)!])
      }
      return
    }

    if (type === 'tool-output-available' || type === 'tool-result' || type === 'tool-output-error') {
      const id = String(chunk.toolCallId || '')
      const task = this.tasks.get(id)
      if (task) {
        task.status = type === 'tool-output-error' || chunk.error ? 'error' : 'complete'
        await this.appendTasks([task])
      }
      return
    }

    if (type === 'data-tool-progress') {
      const id = String(chunk.data?.toolCallId || '')
      const task = this.tasks.get(id)
      if (task && task.status === 'in_progress') {
        await this.appendTasks([task])
      }
      return
    }

    if (type === 'data-turn-complete' || type === 'finish' || type === 'finish-message') {
      const status = chunk.status || chunk.data?.status
      await this.stop(
        status === 'failed' ? 'The Shogo agent could not complete this request.' : undefined,
        status === 'failed' ? 'suspended' : 'active',
      )
    }
  }

  async stop(finalText?: string, sessionStatus: 'active' | 'processing' | 'suspended' | 'closed' = 'active'): Promise<void> {
    if (this.stopped) return
    await this.flushText()
    if (finalText) this.text = finalText

    const streamTs = await this.ensureStream()
    const body: Record<string, unknown> = {
      channel: this.channelId,
      ts: streamTs,
      session_status: sessionStatus,
      blocks: [
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: 'Shogo uses AI to generate responses. Review outputs before acting on them.',
          }],
        },
        {
          type: 'context_actions',
          elements: [{
            type: 'feedback_buttons',
            action_id: 'slack_feedback',
            positive_button: {
              text: { type: 'plain_text', text: 'Helpful' },
              value: 'positive',
            },
            negative_button: {
              text: { type: 'plain_text', text: 'Needs work' },
              value: 'negative',
            },
          }],
        },
      ],
    }
    // `chunks` is optional on `chat.stopStream` (unlike `chat.startStream`) —
    // only include it when there's actual leftover/final text to append.
    // Sending a filler chunk like "Shogo completed this turn." here was a
    // bug: `flushText()` above already sent every real chunk of text via
    // `chat.appendStream`, so `this.text` is normally empty by this point,
    // and this fallback was appending a bogus extra line after every single
    // reply.
    if (this.text) {
      body.chunks = [{
        type: 'markdown_text',
        text: this.text,
      }]
    }
    await this.client.call('chat.stopStream', body)
    // `agents.sessions.setStatus` (called by the route around this writer)
    // doesn't clear the legacy shimmer text set via `setThreadStatus` below
    // — that compatibility-bridge status has its own lifecycle and can
    // otherwise linger showing a stale "is using ..." line next to a reply
    // that already arrived.
    await this.setThreadStatus('')
    this.text = ''
    this.stopped = true
  }

  async fail(message: string): Promise<void> {
    await this.stop(message, 'suspended')
  }

  /**
   * Sets the branded, freeform "Shogo is ..." shimmer text via the legacy
   * `assistant.threads.setStatus` method. `agents.sessions.setStatus` (the
   * modern replacement, used elsewhere for session lifecycle) only supports
   * the fixed active/processing/suspended/closed states with Slack's own
   * generic copy — custom text requires this older method, which Slack
   * still serves through a compatibility bridge. Best-effort: older
   * workspaces or missing scopes must never break the actual response.
   */
  private async setThreadStatus(status: string): Promise<void> {
    await this.client.call('assistant.threads.setStatus', {
      channel_id: this.channelId,
      thread_ts: this.threadTs,
      status,
    }).catch(() => {})
  }

  private async flushText(): Promise<void> {
    if (!this.text) return
    const text = this.text
    this.text = ''
    const streamTs = await this.ensureStream()
    await this.client.call('chat.appendStream', {
      channel: this.channelId,
      ts: streamTs,
      chunks: [{ type: 'markdown_text', text }],
    })
    this.lastFlushAt = this.now()
  }

  private async appendTasks(tasks: SlackTask[]): Promise<void> {
    const streamTs = await this.ensureStream()
    await this.client.call('chat.appendStream', {
      channel: this.channelId,
      ts: streamTs,
      thread_ts: this.threadTs,
      chunks: tasks.map((task) => ({ type: 'task_update', ...task })),
    })
  }

  private async ensureStream(): Promise<string> {
    if (this.streamTs) return this.streamTs
    const response = await this.client.call('chat.startStream', {
      channel: this.channelId,
      thread_ts: this.threadTs,
      task_display_mode: 'plan',
      ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
      ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
    })
    if (!response?.ok || typeof response.ts !== 'string') {
      throw new Error(`Slack chat.startStream failed: ${response?.error || 'missing stream timestamp'}`)
    }
    this.streamTs = response.ts
    return response.ts
  }
}

/** Name used by the forwarding layer and the integration plan. */
export const SlackUiWriter = SlackStreamWriter

function formatToolTitle(value: string, input?: unknown): string {
  const friendly: Record<string, string> = {
    unmount_project: 'Closing project',
    list_projects: 'Checking available projects',
    preview_project: 'Building preview',
  }
  if (friendly[value]) return friendly[value]
  if (value === 'mount_project') {
    let projectId = ''
    if (input && typeof input === 'object') projectId = String((input as any).projectId || '')
    if (typeof input === 'string') {
      try { projectId = String(JSON.parse(input).projectId || '') } catch {}
    }
    return projectId ? `Opening ${projectId}…` : 'Opening project…'
  }
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .slice(0, 120)
}
