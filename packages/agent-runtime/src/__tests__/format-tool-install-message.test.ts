// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins the agent-direct usage block + SDK footer that `connect`
 * appends to its success message. The wording matters: a regression in
 * any of these strings re-creates the failure mode where the agent
 * routes integration calls through `skill` or `agent_spawn({type: "integration"})`
 * instead of calling the bound tools directly.
 */

import { describe, test, expect } from 'bun:test'
import { formatToolInstallMessage } from '../gateway-tools'

const JIRA_TOOLS = [
  'JIRA_LIST_BOARDS',
  'JIRA_GET_CURRENT_USER',
  'JIRA_SEARCH_ISSUES',
  'JIRA_CREATE_ISSUE',
  'JIRA_UPDATE_ISSUE',
  'JIRA_GET_BOARD',
]

describe('formatToolInstallMessage', () => {
  test('active auth: includes "bound to YOU" + named tools + sample call + response shape', () => {
    const msg = formatToolInstallMessage('jira', JIRA_TOOLS, { status: 'active' })

    expect(msg).toContain('"jira" installed with 6 tool(s).')
    expect(msg).toContain('Auth is active.')
    expect(msg).toContain('bound to YOU')
    expect(msg).toContain('JIRA_LIST_BOARDS')
    expect(msg).toContain('JIRA_GET_CURRENT_USER')
    expect(msg).toMatch(/JIRA_LIST_BOARDS\(\{\}\)/)
    expect(msg).toContain('Do NOT spawn an `integration` subagent')
    expect(msg).toContain('Do NOT use the `skill` tool')
    expect(msg).toContain('{ ok: boolean, data: <result>, error?: string }')
    expect(msg).toContain('data.values')
    expect(msg).toContain('@shogo-ai/sdk/tools')
  })

  test('truncates the named-tools hint after 5 entries with an ellipsis marker', () => {
    const msg = formatToolInstallMessage('jira', JIRA_TOOLS, { status: 'active' })
    expect(msg).toContain('JIRA_UPDATE_ISSUE, ...')
    expect(msg).not.toContain('JIRA_GET_BOARD,')
  })

  test('needs_auth with authUrl: tells user about Connect button AND keeps direct-usage block', () => {
    const msg = formatToolInstallMessage('jira', JIRA_TOOLS, {
      status: 'needs_auth',
      authUrl: 'https://example.com/oauth',
    })
    expect(msg).toContain('Connect button')
    expect(msg).not.toContain('https://example.com/oauth')
    expect(msg).toContain('JIRA_LIST_BOARDS')
    expect(msg).toContain('Do NOT spawn an `integration` subagent')
  })

  test('needs_auth without authUrl falls back to Tools panel hint', () => {
    const msg = formatToolInstallMessage('jira', JIRA_TOOLS, { status: 'needs_auth' })
    expect(msg).toContain('Tools panel')
    expect(msg).toContain('JIRA_LIST_BOARDS')
  })

  test('empty toolNames: no named-tools hint but still emits the do-not-misroute block', () => {
    const msg = formatToolInstallMessage('mystery', [], { status: 'active' })
    expect(msg).toContain('"mystery" installed with 0 tool(s).')
    expect(msg).toContain('newly installed')
    expect(msg).toContain('Do NOT spawn an `integration` subagent')
    expect(msg).toContain('Do NOT use the `skill` tool')
    expect(msg).toMatch(/MYSTERY_<TOOL>\(\{\}\)/)
  })
})
