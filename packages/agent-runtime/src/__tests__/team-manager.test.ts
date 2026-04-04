// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'
import { TeamManager } from '../team-manager'

let tm: TeamManager
let persistence: SqliteSessionPersistence

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'team-test-'))
  persistence = new SqliteSessionPersistence(dir)
  tm = new TeamManager(persistence)
})

// ---------------------------------------------------------------------------
// Team CRUD
// ---------------------------------------------------------------------------

describe('Team CRUD', () => {
  test('createTeam creates a team and auto-adds leader as member', () => {
    const team = tm.createTeam('alpha', 'sess-1', 'leader-agent-1')

    expect(team.name).toBe('alpha')
    expect(team.leaderSessionId).toBe('sess-1')
    expect(team.leaderAgentId).toBe('leader-agent-1')
    expect(team.id).toBeTruthy()
    expect(team.createdAt).toBeGreaterThan(0)

    const members = tm.listMembers(team.id)
    expect(members).toHaveLength(1)
    expect(members[0]!.agentId).toBe('team-lead@alpha')
  })

  test('getTeam returns null for non-existent team', () => {
    expect(tm.getTeam('does-not-exist')).toBeNull()
  })

  test('deleteTeam cascades to members, tasks, and mailbox', () => {
    const team = tm.createTeam('cascade', 'sess-1', 'leader-1')
    const member = tm.addMember(team.id, { name: 'worker' })
    tm.createTask(team.id, { subject: 'do stuff' })
    tm.writeMessage(team.id, member.agentId, 'team-lead@cascade', {
      type: 'text',
      message: 'hello',
    })

    tm.deleteTeam(team.id)

    expect(tm.getTeam(team.id)).toBeNull()
    expect(tm.listMembers(team.id)).toHaveLength(0)
    expect(tm.listTasks(team.id)).toHaveLength(0)
    expect(tm.readUnread(member.agentId)).toHaveLength(0)
  })

  test('listTeams returns all teams, optionally filtered by session', () => {
    tm.createTeam('t1', 'sess-A', 'a1')
    tm.createTeam('t2', 'sess-A', 'a2')
    tm.createTeam('t3', 'sess-B', 'b1')

    expect(tm.listTeams()).toHaveLength(3)
    expect(tm.listTeams('sess-A')).toHaveLength(2)
    expect(tm.listTeams('sess-B')).toHaveLength(1)
    expect(tm.listTeams('sess-C')).toHaveLength(0)
  })

  test('creating a team with duplicate name throws (leader agentId collision)', () => {
    tm.createTeam('dup', 'sess-1', 'a1')

    expect(() => tm.createTeam('dup', 'sess-1', 'a2')).toThrow('UNIQUE constraint failed')
  })
})

// ---------------------------------------------------------------------------
// Member Operations
// ---------------------------------------------------------------------------

describe('Member Operations', () => {
  test('addMember creates member with correct agentId format', () => {
    const team = tm.createTeam('dev', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'coder', prompt: 'you code', model: 'fast' })

    expect(member.agentId).toBe(`coder@${team.id}`)
    expect(member.teamId).toBe(team.id)
    expect(member.name).toBe('coder')
    expect(member.prompt).toBe('you code')
    expect(member.model).toBe('fast')
    expect(member.isActive).toBe(true)
  })

  test('removeMember deletes the member', () => {
    const team = tm.createTeam('rm', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'temp' })

    expect(tm.getMember(member.agentId)).not.toBeNull()
    tm.removeMember(member.agentId)
    expect(tm.getMember(member.agentId)).toBeNull()
  })

  test('setMemberActive toggles active state', () => {
    const team = tm.createTeam('toggle', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'bob' })

    expect(tm.getMember(member.agentId)!.isActive).toBe(true)

    tm.setMemberActive(member.agentId, false)
    expect(tm.getMember(member.agentId)!.isActive).toBe(false)

    tm.setMemberActive(member.agentId, true)
    expect(tm.getMember(member.agentId)!.isActive).toBe(true)
  })

  test('listMembers returns all team members', () => {
    const team = tm.createTeam('crew', 'sess-1', 'lead-1')
    tm.addMember(team.id, { name: 'alice' })
    tm.addMember(team.id, { name: 'bob' })

    const members = tm.listMembers(team.id)
    expect(members).toHaveLength(3) // leader + alice + bob
    const names = members.map(m => m.name)
    expect(names).toContain('crew') // leader member uses team name
    expect(names).toContain('alice')
    expect(names).toContain('bob')
  })
})

// ---------------------------------------------------------------------------
// Mailbox Operations
// ---------------------------------------------------------------------------

describe('Mailbox Operations', () => {
  test('writeMessage stores a message', () => {
    const team = tm.createTeam('mail', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'reader' })

    tm.writeMessage(team.id, member.agentId, 'team-lead@mail', {
      type: 'text',
      message: 'ping',
    })

    const msgs = tm.readUnread(member.agentId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.message).toBe('ping')
    expect(msgs[0]!.fromAgent).toBe('team-lead@mail')
    expect(msgs[0]!.messageType).toBe('text')
  })

  test('readUnread returns unread messages and marks them read', () => {
    const team = tm.createTeam('unread', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'recv' })

    tm.writeMessage(team.id, member.agentId, 'team-lead@unread', {
      type: 'text',
      message: 'first',
    })
    tm.writeMessage(team.id, member.agentId, 'team-lead@unread', {
      type: 'text',
      message: 'second',
    })

    const msgs = tm.readUnread(member.agentId)
    expect(msgs).toHaveLength(2)
    expect(msgs.every(m => !m.isRead)).toBe(true) // returned before marking
  })

  test('readUnread called again returns empty (already marked read)', () => {
    const team = tm.createTeam('once', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'once-reader' })

    tm.writeMessage(team.id, member.agentId, 'team-lead@once', {
      type: 'text',
      message: 'ephemeral',
    })

    expect(tm.readUnread(member.agentId)).toHaveLength(1)
    expect(tm.readUnread(member.agentId)).toHaveLength(0)
  })

  test('broadcast (to: *) writes to all members except sender', () => {
    const team = tm.createTeam('bcast', 'sess-1', 'lead-1')
    const alice = tm.addMember(team.id, { name: 'alice' })
    const bob = tm.addMember(team.id, { name: 'bob' })

    tm.writeMessage(team.id, '*', alice.agentId, {
      type: 'text',
      message: 'hey everyone',
    })

    const leaderMsgs = tm.readUnread('team-lead@bcast')
    const bobMsgs = tm.readUnread(bob.agentId)
    const aliceMsgs = tm.readUnread(alice.agentId)

    expect(leaderMsgs).toHaveLength(1)
    expect(bobMsgs).toHaveLength(1)
    expect(aliceMsgs).toHaveLength(0) // sender excluded
  })

  test('messages have correct priority ordering (created_at ASC)', () => {
    const team = tm.createTeam('order', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'ordered' })

    for (let i = 0; i < 5; i++) {
      tm.writeMessage(team.id, member.agentId, 'team-lead@order', {
        type: 'text',
        message: `msg-${i}`,
      })
    }

    const msgs = tm.readUnread(member.agentId)
    expect(msgs).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(msgs[i]!.message).toBe(`msg-${i}`)
    }
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.createdAt).toBeGreaterThanOrEqual(msgs[i - 1]!.createdAt)
    }
  })
})

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

describe('Task CRUD', () => {
  test('createTask creates a task with pending status', () => {
    const team = tm.createTeam('tasks', 'sess-1', 'lead-1')
    const task = tm.createTask(team.id, { subject: 'implement auth' })

    expect(task.subject).toBe('implement auth')
    expect(task.status).toBe('pending')
    expect(task.owner).toBeUndefined()
    expect(task.teamId).toBe(team.id)
    expect(task.blocks).toEqual([])
    expect(task.blockedBy).toEqual([])
  })

  test('listTasks returns non-deleted tasks', () => {
    const team = tm.createTeam('list', 'sess-1', 'lead-1')
    tm.createTask(team.id, { subject: 'task A' })
    tm.createTask(team.id, { subject: 'task B' })

    const tasks = tm.listTasks(team.id)
    expect(tasks).toHaveLength(2)
    expect(tasks.map(t => t.subject)).toEqual(['task A', 'task B'])
  })

  test('updateTask updates status and subject', () => {
    const team = tm.createTeam('upd', 'sess-1', 'lead-1')
    const task = tm.createTask(team.id, { subject: 'old subject' })

    const updated = tm.updateTask(task.id, {
      subject: 'new subject',
      status: 'completed',
    })

    expect(updated).not.toBeNull()
    expect(updated!.subject).toBe('new subject')
    expect(updated!.status).toBe('completed')
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(task.updatedAt)
  })

  test('task with status deleted is excluded from listTasks', () => {
    const team = tm.createTeam('del-task', 'sess-1', 'lead-1')
    const task = tm.createTask(team.id, { subject: 'ephemeral' })

    tm.updateTask(task.id, { status: 'deleted' })

    expect(tm.listTasks(team.id)).toHaveLength(0)
    expect(tm.getTask(task.id)).not.toBeNull()
    expect(tm.getTask(task.id)!.status).toBe('deleted')
  })
})

// ---------------------------------------------------------------------------
// Task Claiming
// ---------------------------------------------------------------------------

describe('Task Claiming', () => {
  test('claimTask atomically sets owner and status', () => {
    const team = tm.createTeam('claim', 'sess-1', 'lead-1')
    const task = tm.createTask(team.id, { subject: 'claimable' })

    const claimed = tm.claimTask(task.id, 'worker-1')
    expect(claimed).toBe(true)

    const loaded = tm.getTask(task.id)!
    expect(loaded.owner).toBe('worker-1')
    expect(loaded.status).toBe('in_progress')
  })

  test('claimTask returns false if already claimed', () => {
    const team = tm.createTeam('double', 'sess-1', 'lead-1')
    const task = tm.createTask(team.id, { subject: 'contested' })

    expect(tm.claimTask(task.id, 'worker-1')).toBe(true)
    expect(tm.claimTask(task.id, 'worker-2')).toBe(false)

    expect(tm.getTask(task.id)!.owner).toBe('worker-1')
  })

  test('claimTask returns false if task not pending', () => {
    const team = tm.createTeam('non-pending', 'sess-1', 'lead-1')
    const task = tm.createTask(team.id, { subject: 'done' })

    tm.updateTask(task.id, { status: 'completed' })
    expect(tm.claimTask(task.id, 'worker-1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Task DAG
// ---------------------------------------------------------------------------

describe('Task DAG', () => {
  test('blockTask sets blocks/blockedBy on both tasks', () => {
    const team = tm.createTeam('dag', 'sess-1', 'lead-1')
    const t1 = tm.createTask(team.id, { subject: 'setup' })
    const t2 = tm.createTask(team.id, { subject: 'deploy' })

    tm.blockTask(t1.id, t2.id)

    const from = tm.getTask(t1.id)!
    const to = tm.getTask(t2.id)!
    expect(from.blocks).toContain(t2.id)
    expect(to.blockedBy).toContain(t1.id)
  })

  test('findAvailableTask skips blocked tasks', () => {
    const team = tm.createTeam('blocked', 'sess-1', 'lead-1')
    const t1 = tm.createTask(team.id, { subject: 'prerequisite' })
    const t2 = tm.createTask(team.id, { subject: 'dependent' })

    tm.blockTask(t1.id, t2.id)

    const available = tm.findAvailableTask(team.id)
    expect(available).not.toBeNull()
    expect(available!.id).toBe(t1.id)
  })

  test('findAvailableTask returns unblocked task when dependency completes', () => {
    const team = tm.createTeam('unblock', 'sess-1', 'lead-1')
    const t1 = tm.createTask(team.id, { subject: 'prerequisite' })
    const t2 = tm.createTask(team.id, { subject: 'dependent' })

    tm.blockTask(t1.id, t2.id)

    tm.claimTask(t1.id, 'worker-1')
    tm.updateTask(t1.id, { status: 'completed' })

    const available = tm.findAvailableTask(team.id)
    expect(available).not.toBeNull()
    expect(available!.id).toBe(t2.id)
  })

  test('findAvailableTask returns null when all tasks are blocked or claimed', () => {
    const team = tm.createTeam('stuck', 'sess-1', 'lead-1')
    const t1 = tm.createTask(team.id, { subject: 'claimed' })
    const t2 = tm.createTask(team.id, { subject: 'blocked' })

    tm.blockTask(t1.id, t2.id)
    tm.claimTask(t1.id, 'worker-1')

    expect(tm.findAvailableTask(team.id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

describe('Integration', () => {
  test('full workflow: create team → add members → create tasks → claim → complete → find next', () => {
    const team = tm.createTeam('fullflow', 'sess-1', 'lead-1', {
      description: 'end-to-end test',
    })

    const alice = tm.addMember(team.id, { name: 'alice', prompt: 'frontend dev' })
    const bob = tm.addMember(team.id, { name: 'bob', prompt: 'backend dev' })

    const design = tm.createTask(team.id, { subject: 'design API' })
    const implement = tm.createTask(team.id, { subject: 'implement API' })
    const test_ = tm.createTask(team.id, { subject: 'write tests' })

    tm.blockTask(design.id, implement.id)
    tm.blockTask(implement.id, test_.id)

    expect(tm.findAvailableTask(team.id)!.id).toBe(design.id)

    expect(tm.claimTask(design.id, alice.agentId)).toBe(true)
    expect(tm.findAvailableTask(team.id)).toBeNull()

    tm.updateTask(design.id, { status: 'completed' })
    expect(tm.findAvailableTask(team.id)!.id).toBe(implement.id)

    expect(tm.claimTask(implement.id, bob.agentId)).toBe(true)
    tm.updateTask(implement.id, { status: 'completed' })

    const next = tm.findAvailableTask(team.id)
    expect(next).not.toBeNull()
    expect(next!.id).toBe(test_.id)

    tm.writeMessage(team.id, alice.agentId, bob.agentId, {
      type: 'text',
      message: 'API is done, tests are unblocked',
    })
    const msgs = tm.readUnread(alice.agentId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.fromAgent).toBe(bob.agentId)
  })

  test('deleting a team cascades everything', () => {
    const team = tm.createTeam('doomed', 'sess-1', 'lead-1')
    const member = tm.addMember(team.id, { name: 'temp' })
    const task = tm.createTask(team.id, { subject: 'wont finish' })

    tm.writeMessage(team.id, member.agentId, 'team-lead@doomed', {
      type: 'task_assignment',
      message: 'do this',
    })

    tm.deleteTeam(team.id)

    expect(tm.getTeam(team.id)).toBeNull()
    expect(tm.getMember(member.agentId)).toBeNull()
    expect(tm.getTask(task.id)).toBeNull()
    expect(tm.readUnread(member.agentId)).toHaveLength(0)
    expect(tm.listTeams()).toHaveLength(0)
  })
})
