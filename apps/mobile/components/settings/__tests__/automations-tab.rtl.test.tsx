// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { observable, runInAction } from 'mobx'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ testID, children, onPress, disabled }: any) =>
      createElement('div', { role: 'button', 'data-testid': testID, 'aria-disabled': disabled || undefined, onClick: disabled ? undefined : onPress }, children),
    View: ({ testID, children }: any) => createElement('div', { 'data-testid': testID }, children),
    TextInput: ({ testID, value, onChangeText, placeholder }: any) =>
      createElement('input', { 'data-testid': testID, value, placeholder, onChange: (e: any) => onChangeText(e.target.value) }),
  } as any),
)
const passthrough = ({ children }: any) => createElement('div', null, children)
mock.module('@shogo/shared-ui/primitives', () => ({
  Badge: passthrough,
  Card: passthrough,
  CardContent: passthrough,
  Skeleton: () => createElement('div', { 'data-testid': 'skeleton' }),
  Button: ({ children, onPress, testID }: any) => createElement('button', { onClick: onPress, 'data-testid': testID }, children),
  Switch: ({ checked, onCheckedChange }: any) =>
    createElement('input', { type: 'checkbox', checked, onChange: () => onCheckedChange(!checked) }),
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
}))
mock.module('../account-sheet-chrome', () => ({
  Text: ({ children }: any) => createElement('span', null, children),
  useAccountSheetIcons: (icons: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(icons).map((k) => [k, () => null])),
}))
const pushed: string[] = []
const prefills: string[] = []
mock.module('expo-router', () => ({ useRouter: () => ({ push: (href: string) => pushed.push(href) }) }))
mock.module('../../../hooks/useChatPrefill', () => ({ setChatPrefill: (text: string) => prefills.push(text) }))
const activeWorkspace = observable.box<{ id: string } | null>({ id: 'ws-1' })
mock.module('../../../hooks/useActiveWorkspace', () => ({ useActiveWorkspace: () => activeWorkspace.get() }))
const http = {}
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => http }))

const calls: Array<[string, ...unknown[]]> = []
let triggers: any[]
let grants: any[]
let updateError: string | null = null
mock.module('../../../lib/api', () => ({
  api: {
    listWorkspaceTriggers: async () => triggers,
    listWorkspaceAppGrants: async () => grants,
    getWorkspaceIntegrationConnections: async () => [{ id: 'c1', toolkit: 'github', status: 'ACTIVE' }],
    setWorkspaceTriggerEnabled: async (_h: unknown, _ws: string, id: string, enabled: boolean) => {
      calls.push(['toggle', id, enabled])
      return { ...triggers.find((t) => t.id === id), enabled }
    },
    updateWorkspaceTrigger: async (_h: unknown, _ws: string, id: string, patch: Record<string, unknown>) => {
      calls.push(['update', id, patch])
      if (updateError) throw new Error(updateError)
      return { ...triggers.find((t) => t.id === id), ...patch }
    },
    getTriggerActorFields: async (_h: unknown, _ws: string, eventType: string) => {
      calls.push(['actorFields', eventType])
      return { idPaths: ['issue.fields.reporter.accountId', 'user_id'], emailPaths: ['issue.fields.reporter.emailAddress'] }
    },
    listTriggerDeliveries: async (_h: unknown, _ws: string, id: string) => {
      calls.push(['deliveries', id])
      return [{ id: 'd1', status: 'dead', attempts: 5, error: 'hook exploded', createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z' }]
    },
    redeliverTriggerDelivery: async (_h: unknown, _ws: string, id: string, deliveryId: string) => {
      calls.push(['redeliver', id, deliveryId])
      return { id: deliveryId, status: 'pending', attempts: 0, error: null }
    },
    revokeAppInstall: async (_h: unknown, installId: string) => {
      calls.push(['revoke', installId])
      grants = grants.map((g) => (g.installId === installId ? { ...g, status: 'revoked' } : g))
    },
  },
}))

const { AutomationsTab } = await import('../AutomationsTab')

const base = { enabled: true, consecutiveFailures: 0, createdAt: '2026-10-01T00:00:00Z', ownerKind: 'user' }

beforeEach(() => {
  triggers = [
    { ...base, id: 't1', name: 'Welcome newcomers', eventType: 'member.joined', source: 'shogo', target: 'agent' },
    { ...base, id: 't2', name: 'Greeter: Greet', eventType: 'member.joined', source: 'shogo', target: 'project', targetMode: 'hook', ownerKind: 'app', installId: 'inst-1' },
    { ...base, id: 't4', name: 'File PRs for newcomers', eventType: 'member.joined', source: 'shogo', target: 'project', targetMode: 'agent', actsAs: 'subscriber' },
    { ...base, id: 't5', name: 'Jira to GitHub', eventType: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER', source: 'composio', target: 'project', targetMode: 'agent', actsAs: 'subscriber' },
    { ...base, id: 't3', name: 'New issues', eventType: 'composio.github.GITHUB_ISSUE_ADDED_EVENT', source: 'composio', target: 'webhook', webhookUrl: 'https://hooks.example.com/x', enabled: false, consecutiveFailures: 5, lastError: 'HTTP 500' },
  ]
  grants = [{
    id: 'g1', installId: 'inst-1', status: 'active', version: '1.0.0', grantedScopes: ['members:read', 'chat:write'],
    grantedToolkits: [], pendingScopes: ['channels:manage'], pendingVersion: '1.1.0', hasToken: true, createdAt: '2026-10-01T00:00:00Z',
    app: { slug: 'greeter', title: 'Greeter', iconUrl: null }, projectId: 'p1', installStatus: 'active', grantedBy: { id: 'u1', name: 'Russell' },
  }]
  ;(globalThis as any).window.confirm = () => true
})

afterEach(() => {
  cleanup()
  runInAction(() => activeWorkspace.set({ id: 'ws-1' }))
  updateError = null
  calls.length = 0
  pushed.length = 0
  prefills.length = 0
})

describe('AutomationsTab', () => {
  test('groups triggers by event source and labels app-owned ones and auto-disabled ones', async () => {
    render(<AutomationsTab />)
    const shogo = await screen.findByTestId('automation-group-Shogo')
    expect(within(shogo).getByText('Welcome newcomers')).toBeTruthy()
    expect(within(shogo).getByText('App · Greeter')).toBeTruthy()
    expect(within(shogo).getByText(/Project hook/)).toBeTruthy()

    const github = screen.getByTestId('automation-group-Github')
    expect(within(github).getByText('Auto-disabled')).toBeTruthy()
    expect(within(github).getByText('HTTP 500')).toBeTruthy()
    expect(within(github).getByText(/Webhook → hooks.example.com/)).toBeTruthy()
    expect(screen.getByText('github')).toBeTruthy()
  })

  test('re-enables a trigger, and redelivers a dead delivery from its history', async () => {
    render(<AutomationsTab />)
    fireEvent.click(within(await screen.findByTestId('automation-trigger-toggle-t3')).getByRole('checkbox'))
    await waitFor(() => expect(calls).toContainEqual(['toggle', 't3', true]))

    fireEvent.click(screen.getByText('Welcome newcomers'))
    const t1 = screen.getByTestId('automation-trigger-t1')
    expect(await within(t1).findByText('hook exploded')).toBeTruthy()
    fireEvent.click(within(t1).getByTestId('automation-redeliver-d1'))
    await waitFor(() => expect(calls).toContainEqual(['redeliver', 't1', 'd1']))
    expect(await within(t1).findByText('pending')).toBeTruthy()
  })

  test('lists apps with access, pending scope requests, and revokes after confirmation', async () => {
    render(<AutomationsTab />)
    const row = await screen.findByTestId('app-grant-inst-1')
    expect(within(row).getByText('members:read')).toBeTruthy()
    expect(within(row).getByText(/v1.1.0 asks for channels:manage/)).toBeTruthy()

    ;(globalThis as any).window.confirm = () => false
    fireEvent.click(screen.getByTestId('app-grant-revoke-inst-1'))
    expect(calls.some((c) => c[0] === 'revoke')).toBe(false)

    ;(globalThis as any).window.confirm = () => true
    fireEvent.click(screen.getByTestId('app-grant-revoke-inst-1'))
    await waitFor(() => expect(calls).toContainEqual(['revoke', 'inst-1']))
    expect(await screen.findByText('No marketplace app has access to this workspace.')).toBeTruthy()
  })

  test('New automation opens the workspace agent with the request pre-typed, closing a settings sheet first', async () => {
    const order: string[] = []
    render(<AutomationsTab onLeaveSettings={() => order.push('closed')} />)
    fireEvent.click(await screen.findByTestId('automations-create'))
    expect(prefills).toEqual(['I want you to create an automation in this workspace that '])
    expect(order).toEqual(['closed'])
    expect(pushed).toEqual(['/(app)/agent'])
  })

  test('project agent triggers choose whose accounts they act as; others do not offer it', async () => {
    render(<AutomationsTab />)
    fireEvent.click(await screen.findByText('File PRs for newcomers'))
    const row = screen.getByTestId('automation-trigger-t4')
    expect(within(row).getByText('Integrations act as')).toBeTruthy()
    fireEvent.click(within(row).getByTestId('automation-acts-as-t4-actor'))
    await waitFor(() => expect(calls).toContainEqual(['update', 't4', { actsAs: 'actor' }]))
    expect(await within(row).findByText(/Acts as the person behind the event/)).toBeTruthy()

    // Workspace-agent and app-owned hook triggers have nothing to choose.
    fireEvent.click(screen.getByText('Welcome newcomers'))
    fireEvent.click(screen.getByText('Greeter: Greet'))
    expect(screen.queryByTestId('automation-acts-as-t1')).toBeNull()
    expect(screen.queryByTestId('automation-acts-as-t2')).toBeNull()
  })

  test('a Composio trigger picks the field that says who did it before switching', async () => {
    render(<AutomationsTab />)
    fireEvent.click(await screen.findByText('Jira to GitHub'))
    const row = screen.getByTestId('automation-trigger-t5')
    fireEvent.click(within(row).getByTestId('automation-acts-as-t5-actor'))
    expect(calls.some((c) => c[0] === 'update')).toBe(false)
    await waitFor(() => expect(calls).toContainEqual(['actorFields', 'composio.jira.JIRA_NEW_ISSUE_TRIGGER']))
    fireEvent.click(await within(row).findByTestId('automation-actor-field-issue.fields.reporter.accountId'))
    expect((within(row).getByTestId('automation-actor-path-t5') as HTMLInputElement).value).toBe('issue.fields.reporter.accountId')
    fireEvent.click(within(row).getByTestId('automation-actor-save-t5'))
    await waitFor(() => expect(calls).toContainEqual(['update', 't5', { actsAs: 'actor', actorIdPath: 'issue.fields.reporter.accountId' }]))

    // Now acting as the actor, matching by email is an explicit opt-in.
    const email = await within(row).findByTestId('automation-trust-email-t5')
    fireEvent.click(within(email).getByRole('checkbox'))
    await waitFor(() => expect(calls).toContainEqual(['update', 't5', { trustActorEmail: true, actorEmailPath: 'issue.fields.reporter.emailAddress' }]))
  })

  test('loads triggers once the workspace list arrives after the first render', async () => {
    runInAction(() => activeWorkspace.set(null))
    render(<AutomationsTab />)
    expect(screen.getByText('0 triggers')).toBeTruthy()

    runInAction(() => activeWorkspace.set({ id: 'ws-1' }))
    expect(await screen.findByTestId('automation-trigger-t1')).toBeTruthy()
  })

  test('shows why a change was refused', async () => {
    updateError = "Only a workspace admin or the project's creator can make a trigger act as the person who triggered it"
    render(<AutomationsTab />)
    fireEvent.click(await screen.findByText('File PRs for newcomers'))
    const row = screen.getByTestId('automation-trigger-t4')
    fireEvent.click(within(row).getByTestId('automation-acts-as-t4-actor'))
    expect(await within(row).findByText(/Only a workspace admin/)).toBeTruthy()
  })
})
