// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TeamManager — Teammate Coordination Layer
 *
 * Manages teams of long-lived agent teammates with SQLite-backed persistence
 * for teams, members, tasks (with DAG dependencies), and mailbox messaging.
 * Adapted from Claude Code's file-based swarm system to use Shogo's SQLite layer.
 */

import { Database } from 'bun:sqlite'
import type { SqliteSessionPersistence } from './sqlite-session-persistence'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamInfo {
  id: string
  name: string
  description?: string
  leaderSessionId: string
  leaderAgentId: string
  createdAt: number
  config?: Record<string, unknown>
}

export interface NewMember {
  name: string
  prompt?: string
  model?: string
  color?: string
}

export interface MemberInfo {
  agentId: string
  teamId: string
  name: string
  prompt?: string
  model?: string
  color?: string
  isActive: boolean
  joinedAt: number
}

export interface TaskInfo {
  id: number
  teamId: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  owner?: string
  blocks: number[]
  blockedBy: number[]
  activeForm?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface NewTask {
  subject: string
  description?: string
  activeForm?: string
  metadata?: Record<string, unknown>
}

export interface TaskUpdate {
  subject?: string
  description?: string
  activeForm?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
  addBlocks?: number[]
  addBlockedBy?: number[]
  owner?: string
  metadata?: Record<string, unknown>
}

export type MailboxMessageType =
  | 'text'
  | 'shutdown_request'
  | 'shutdown_response'
  | 'permission_request'
  | 'permission_response'
  | 'task_assignment'
  | 'idle_notification'
  | 'plan_approval_request'
  | 'plan_approval_response'

export interface MailboxMessage {
  id: number
  teamId: string
  toAgent: string
  fromAgent: string
  messageType: MailboxMessageType
  message: string
  summary?: string
  isRead: boolean
  createdAt: number
}

export interface NewMailboxMessage {
  type: MailboxMessageType
  message: string
  summary?: string
}

// ---------------------------------------------------------------------------
// TeamManager
// ---------------------------------------------------------------------------

export class TeamManager {
  private db: Database

  constructor(persistence: SqliteSessionPersistence) {
    this.db = persistence.getDb()
  }

  // -------------------------------------------------------------------------
  // Team CRUD
  // -------------------------------------------------------------------------

  createTeam(
    name: string,
    leaderSessionId: string,
    leaderAgentId: string,
    opts?: { description?: string; config?: Record<string, unknown> },
  ): TeamInfo {
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(
      `INSERT INTO teams (id, name, description, leader_session_id, leader_agent_id, created_at, config)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, name, opts?.description ?? null, leaderSessionId, leaderAgentId, now, opts?.config ? JSON.stringify(opts.config) : null)

    const leaderMemberId = `team-lead@${name}`
    this.db.prepare(
      `INSERT INTO team_members (agent_id, team_id, name, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(leaderMemberId, name, name, now)

    return {
      id: name,
      name,
      description: opts?.description,
      leaderSessionId,
      leaderAgentId,
      createdAt: now,
      config: opts?.config,
    }
  }

  deleteTeam(teamId: string): void {
    this.db.prepare('DELETE FROM teams WHERE id = ?').run(teamId)
  }

  getTeam(teamId: string): TeamInfo | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as any
    return row ? this.rowToTeam(row) : null
  }

  listTeams(sessionId?: string): TeamInfo[] {
    if (sessionId) {
      const rows = this.db.prepare('SELECT * FROM teams WHERE leader_session_id = ?').all(sessionId) as any[]
      return rows.map(r => this.rowToTeam(r))
    }
    const rows = this.db.prepare('SELECT * FROM teams').all() as any[]
    return rows.map(r => this.rowToTeam(r))
  }

  // -------------------------------------------------------------------------
  // Member ops
  // -------------------------------------------------------------------------

  addMember(teamId: string, member: NewMember): MemberInfo {
    const agentId = `${member.name}@${teamId}`
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(
      `INSERT INTO team_members (agent_id, team_id, name, prompt, model, color, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, teamId, member.name, member.prompt ?? null, member.model ?? null, member.color ?? null, now)

    return {
      agentId,
      teamId,
      name: member.name,
      prompt: member.prompt,
      model: member.model,
      color: member.color,
      isActive: true,
      joinedAt: now,
    }
  }

  removeMember(agentId: string): void {
    this.db.prepare('DELETE FROM team_members WHERE agent_id = ?').run(agentId)
  }

  getMember(agentId: string): MemberInfo | null {
    const row = this.db.prepare('SELECT * FROM team_members WHERE agent_id = ?').get(agentId) as any
    return row ? this.rowToMember(row) : null
  }

  listMembers(teamId: string): MemberInfo[] {
    const rows = this.db.prepare('SELECT * FROM team_members WHERE team_id = ?').all(teamId) as any[]
    return rows.map(r => this.rowToMember(r))
  }

  setMemberActive(agentId: string, active: boolean): void {
    this.db.prepare('UPDATE team_members SET is_active = ? WHERE agent_id = ?').run(active ? 1 : 0, agentId)
  }

  // -------------------------------------------------------------------------
  // Mailbox ops
  // -------------------------------------------------------------------------

  writeMessage(teamId: string, to: string, from: string, msg: NewMailboxMessage): void {
    if (to === '*') {
      const members = this.db.prepare(
        'SELECT agent_id FROM team_members WHERE team_id = ? AND agent_id != ?',
      ).all(teamId, from) as Array<{ agent_id: string }>

      const stmt = this.db.prepare(
        `INSERT INTO team_mailbox (team_id, to_agent, from_agent, message_type, message, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const m of members) {
        stmt.run(teamId, m.agent_id, from, msg.type, msg.message, msg.summary ?? null)
      }
    } else {
      this.db.prepare(
        `INSERT INTO team_mailbox (team_id, to_agent, from_agent, message_type, message, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(teamId, to, from, msg.type, msg.message, msg.summary ?? null)
    }
  }

  readUnread(agentId: string): MailboxMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM team_mailbox
       WHERE to_agent = ? AND is_read = 0
       ORDER BY created_at ASC`,
    ).all(agentId) as any[]

    if (rows.length > 0) {
      const ids = rows.map(r => r.id)
      this.db.prepare(
        `UPDATE team_mailbox SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).run(...ids)
    }

    return rows.map(r => this.rowToMailbox(r))
  }

  markRead(messageIds: number[]): void {
    if (messageIds.length === 0) return
    this.db.prepare(
      `UPDATE team_mailbox SET is_read = 1 WHERE id IN (${messageIds.map(() => '?').join(',')})`,
    ).run(...messageIds)
  }

  // -------------------------------------------------------------------------
  // Task ops
  // -------------------------------------------------------------------------

  createTask(teamId: string, task: NewTask): TaskInfo {
    const now = Math.floor(Date.now() / 1000)
    const result = this.db.prepare(
      `INSERT INTO team_tasks (team_id, subject, description, active_form, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(teamId, task.subject, task.description ?? null, task.activeForm ?? null, task.metadata ? JSON.stringify(task.metadata) : '{}', now, now)

    return this.getTask(Number(result.lastInsertRowid))!
  }

  getTask(taskId: number): TaskInfo | null {
    const row = this.db.prepare('SELECT * FROM team_tasks WHERE id = ?').get(taskId) as any
    return row ? this.rowToTask(row) : null
  }

  listTasks(teamId: string): TaskInfo[] {
    const rows = this.db.prepare(
      `SELECT * FROM team_tasks WHERE team_id = ? AND status != 'deleted' ORDER BY created_at ASC`,
    ).all(teamId) as any[]
    return rows.map(r => this.rowToTask(r))
  }

  updateTask(taskId: number, updates: TaskUpdate): TaskInfo | null {
    const existing = this.getTask(taskId)
    if (!existing) return null

    const now = Math.floor(Date.now() / 1000)
    const subject = updates.subject ?? existing.subject
    const description = updates.description !== undefined ? updates.description : existing.description
    const activeForm = updates.activeForm !== undefined ? updates.activeForm : existing.activeForm
    const status = updates.status ?? existing.status
    const owner = updates.owner !== undefined ? updates.owner : existing.owner
    const metadata = updates.metadata
      ? JSON.stringify({ ...existing.metadata, ...updates.metadata })
      : JSON.stringify(existing.metadata)

    let blocks = existing.blocks
    if (updates.addBlocks) {
      blocks = [...new Set([...blocks, ...updates.addBlocks])]
    }

    let blockedBy = existing.blockedBy
    if (updates.addBlockedBy) {
      blockedBy = [...new Set([...blockedBy, ...updates.addBlockedBy])]
    }

    this.db.prepare(
      `UPDATE team_tasks
       SET subject = ?, description = ?, active_form = ?, status = ?, owner = ?,
           blocks = ?, blocked_by = ?, metadata = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      subject,
      description ?? null,
      activeForm ?? null,
      status,
      owner ?? null,
      JSON.stringify(blocks),
      JSON.stringify(blockedBy),
      metadata,
      now,
      taskId,
    )

    return this.getTask(taskId)
  }

  claimTask(taskId: number, agentId: string): boolean {
    const now = Math.floor(Date.now() / 1000)
    const result = this.db.prepare(
      `UPDATE team_tasks SET owner = ?, status = 'in_progress', updated_at = ?
       WHERE id = ? AND owner IS NULL AND status = 'pending'`,
    ).run(agentId, now, taskId)
    return result.changes > 0
  }

  findAvailableTask(teamId: string): TaskInfo | null {
    const pending = this.db.prepare(
      `SELECT * FROM team_tasks
       WHERE team_id = ? AND status = 'pending' AND owner IS NULL
       ORDER BY created_at ASC`,
    ).all(teamId) as any[]

    for (const row of pending) {
      const blockedBy = this.parseJsonArray(row.blocked_by)
      if (blockedBy.length === 0) return this.rowToTask(row)

      const allCompleted = blockedBy.every((depId: number) => {
        const dep = this.db.prepare('SELECT status FROM team_tasks WHERE id = ?').get(depId) as any
        return dep?.status === 'completed'
      })
      if (allCompleted) return this.rowToTask(row)
    }

    return null
  }

  blockTask(fromId: number, toId: number): void {
    const fromTask = this.getTask(fromId)
    const toTask = this.getTask(toId)
    if (!fromTask || !toTask) return

    const fromBlocks = [...new Set([...fromTask.blocks, toId])]
    const toBlockedBy = [...new Set([...toTask.blockedBy, fromId])]

    this.db.prepare('UPDATE team_tasks SET blocks = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(fromBlocks), Math.floor(Date.now() / 1000), fromId)
    this.db.prepare('UPDATE team_tasks SET blocked_by = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(toBlockedBy), Math.floor(Date.now() / 1000), toId)
  }

  getRecentMessages(teamId: string, limit: number = 50): MailboxMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM team_mailbox
       WHERE team_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(teamId, limit) as any[]
    return rows.reverse().map(r => this.rowToMailbox(r))
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  private rowToTeam(row: any): TeamInfo {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      leaderSessionId: row.leader_session_id,
      leaderAgentId: row.leader_agent_id,
      createdAt: row.created_at,
      config: row.config ? JSON.parse(row.config) : undefined,
    }
  }

  private rowToMember(row: any): MemberInfo {
    return {
      agentId: row.agent_id,
      teamId: row.team_id,
      name: row.name,
      prompt: row.prompt ?? undefined,
      model: row.model ?? undefined,
      color: row.color ?? undefined,
      isActive: row.is_active === 1,
      joinedAt: row.joined_at,
    }
  }

  private rowToTask(row: any): TaskInfo {
    return {
      id: row.id,
      teamId: row.team_id,
      subject: row.subject,
      description: row.description ?? undefined,
      status: row.status,
      owner: row.owner ?? undefined,
      blocks: this.parseJsonArray(row.blocks),
      blockedBy: this.parseJsonArray(row.blocked_by),
      activeForm: row.active_form ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private rowToMailbox(row: any): MailboxMessage {
    return {
      id: row.id,
      teamId: row.team_id,
      toAgent: row.to_agent,
      fromAgent: row.from_agent,
      messageType: row.message_type,
      message: row.message,
      summary: row.summary ?? undefined,
      isRead: row.is_read === 1,
      createdAt: row.created_at,
    }
  }

  private parseJsonArray(val: string | null): number[] {
    if (!val) return []
    try { return JSON.parse(val) } catch { return [] }
  }
}
