// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-455 — `acceptInvitation` must survive a membership that already exists.
 *
 * The action creates the member first and marks the invitation accepted second
 * (SHO-422, so a refused seat does not burn the link). When the invitee is
 * already in the scope the API answers `409 already_member`, which used to
 * reject the whole accept: the invitation stayed `pending` forever and the
 * accept page showed the raw hook string with no redirect.
 *
 * The membership the invitation asks for is already in place, so the only thing
 * left to do is consume the invitation. Every other failure still rejects.
 */
import { test, expect } from 'bun:test'
import { createDomainActions } from '../domain-actions'

function makeStore(opts: { create?: (input: any) => Promise<unknown> } = {}) {
  const calls: string[] = []
  const updates: { id: string; changes: any }[] = []
  const store = {
    invitationCollection: {
      get: (id: string) => ({ id, workspaceId: 'w1', role: 'member' }),
      loadById: async () => undefined,
      update: async (id: string, changes: any) => {
        calls.push('invitation.update')
        updates.push({ id, changes })
        return { id, ...changes }
      },
    },
    memberCollection: {
      create: async (input: any) => {
        calls.push('member.create')
        return opts.create ? opts.create(input) : { id: 'm1', ...input }
      },
    },
  }
  return { store, calls, updates }
}

const alreadyMember = () =>
  Object.assign(new Error('User is already a member'), {
    name: 'ShogoError',
    status: 409,
    code: 'CONFLICT',
    details: { error: { code: 'already_member', message: 'User is already a member' } },
  })

test('an already-member accept consumes the invitation instead of failing', async () => {
  const { store, calls, updates } = makeStore({
    create: async () => {
      throw alreadyMember()
    },
  })
  const actions = createDomainActions(store as never)

  const result = await actions.acceptInvitation('inv-1', 'u1', { workspaceId: 'w1', role: 'member' })

  expect(result).toMatchObject({ workspaceId: 'w1', role: 'member' })
  expect(calls).toEqual(['member.create', 'invitation.update'])
  expect(updates[0]).toEqual({ id: 'inv-1', changes: { status: 'accepted' } })
})

test('a refused seat still rejects and leaves the invitation pending', async () => {
  const { store, calls } = makeStore({
    create: async () => {
      throw Object.assign(new Error('This workspace is limited to 3 seats'), {
        name: 'ShogoError',
        status: 409,
        code: 'TRIAL_SEAT_LIMIT',
        details: { error: { code: 'trial_seat_limit', message: 'This workspace is limited to 3 seats' } },
      })
    },
  })
  const actions = createDomainActions(store as never)

  await expect(
    actions.acceptInvitation('inv-1', 'u1', { workspaceId: 'w1', role: 'member' }),
  ).rejects.toThrow(/limited to 3 seats/)
  // SHO-422: the invitee's only link must survive a refused join.
  expect(calls).toEqual(['member.create'])
})

test('a genuine failure still rejects', async () => {
  const { store, calls } = makeStore({
    create: async () => {
      throw Object.assign(new Error('Request failed with status 500'), {
        name: 'ShogoError',
        status: 500,
        code: 'SERVER_ERROR',
      })
    },
  })
  const actions = createDomainActions(store as never)

  await expect(
    actions.acceptInvitation('inv-1', 'u1', { workspaceId: 'w1', role: 'member' }),
  ).rejects.toThrow(/status 500/)
  expect(calls).toEqual(['member.create'])
})

test('a successful accept creates the member before consuming the invitation', async () => {
  const { store, calls } = makeStore()
  const actions = createDomainActions(store as never)

  await actions.acceptInvitation('inv-1', 'u1', { workspaceId: 'w1', role: 'member' })

  expect(calls).toEqual(['member.create', 'invitation.update'])
})
