// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  chainLimitHit,
  humanChain,
  MAX_AGENT_CHAIN_DEPTH,
  MAX_AGENT_PING_PONG_TURNS,
  MAX_AGENT_TURNS_PER_THREAD,
  nextChain,
  pingPongRun,
  readChain,
} from '../services/conversation-agent-chain'
import { buildMentionLookup, resolveFriendlyMentionsWith } from '../services/conversation-mentions'
import { scriptedAgentInvokeFromEnv } from '../services/conversation-agent-script'

const A = { projectId: 'a' }
const B = { projectId: 'b' }
const C = { projectId: 'c' }

describe('chain limits', () => {
  test('defaults', () => {
    expect(MAX_AGENT_CHAIN_DEPTH).toBe(12)
    expect(MAX_AGENT_TURNS_PER_THREAD).toBe(40)
    expect(MAX_AGENT_PING_PONG_TURNS).toBe(4)
  })

  test('a person starts at depth 0; each hop is one deeper and records the agent', () => {
    const start = humanChain({ id: 'm1', threadRootId: null }, 'u1', { rootMessageId: 'x', originUserId: 'u9', depth: 3, hops: [], turns: 0, runId: 'r1' })
    expect(start).toEqual({ rootMessageId: 'm1', originUserId: 'u1', depth: 0, hops: [], turns: 0, runId: 'r1' })
    const one = nextChain(start, A, 0)
    const two = nextChain(one, B, 1)
    expect(two).toMatchObject({ depth: 2, hops: ['p:a', 'p:b'], turns: 2, originUserId: 'u1', runId: 'r1' })
  })

  test('the thread owner is not copied onto replies', () => {
    const next = nextChain({ rootMessageId: 'r', originUserId: 'u', depth: 0, hops: [], turns: 0, owner: A }, B, 0)
    expect(next.owner).toBeUndefined()
  })

  test('depth trips past the maximum', () => {
    let chain = humanChain({ id: 'm' }, 'u')
    const agents = [A, B, C]
    for (let i = 0; i < MAX_AGENT_CHAIN_DEPTH; i++) {
      chain = nextChain(chain, agents[i % 3], 0)
      expect(chainLimitHit(chain)).toBeNull()
    }
    expect(chainLimitHit(nextChain(chain, agents[0], 0))).toBe('depth')
  })

  test('thread turns trip past the maximum', () => {
    const chain = nextChain(humanChain({ id: 'm' }, 'u'), A, MAX_AGENT_TURNS_PER_THREAD)
    expect(chainLimitHit(chain)).toBe('thread_turns')
  })

  test('ping-pong counts the alternating run at the end', () => {
    expect(pingPongRun([])).toBe(0)
    expect(pingPongRun(['a'])).toBe(1)
    expect(pingPongRun(['a', 'a'])).toBe(1)
    expect(pingPongRun(['a', 'b'])).toBe(2)
    expect(pingPongRun(['c', 'a', 'b', 'a', 'b'])).toBe(4)
    expect(pingPongRun(['a', 'b', 'c', 'b', 'c'])).toBe(4)
    expect(pingPongRun(['a', 'b', 'c', 'a', 'b', 'c'])).toBe(2)
    const chain = { rootMessageId: 'r', originUserId: 'u', depth: 1, hops: ['p:a', 'p:b', 'p:a', 'p:b'], turns: 4 }
    expect(chainLimitHit(chain)).toBeNull()
    expect(chainLimitHit(nextChain(chain, A, 4))).toBe('ping_pong')
  })

  test('readChain accepts stored JSON (object or SQLite string) and rejects junk', () => {
    const stored = { rootMessageId: 'r', originUserId: 'u', depth: 2, hops: ['p:a', 3], turns: 2, owner: { projectId: null } }
    expect(readChain(stored)).toEqual({ rootMessageId: 'r', originUserId: 'u', depth: 2, hops: ['p:a'], turns: 2, owner: { projectId: null } })
    expect(readChain(JSON.stringify(stored))?.depth).toBe(2)
    expect(readChain('not json')).toBeNull()
    expect(readChain({ depth: 1 })).toBeNull()
    expect(readChain(null)).toBeNull()
  })
})

describe('friendly mentions', () => {
  const lookup = buildMentionLookup([
    { token: '<@a:p:an>', names: ['Issue Pipeline — Analyst', 'Analyst'] },
    { token: '<@a:p:dg>', names: ['Done Gate'] },
    { token: '<@u:u1>', names: ['Ana Lima', 'ana@example.com', 'Ana'] },
    { token: '<@u:u2>', names: ['Ana Souza', 'ana.s@example.com', 'Ana'] },
    { token: '<@g:g1>', names: ['maintainers', 'Maintainers'] },
  ])

  test('resolves full names, short agent names, emails and group handles', () => {
    expect(resolveFriendlyMentionsWith('@Analyst and @Issue Pipeline — Analyst', lookup)).toBe('<@a:p:an> and <@a:p:an>')
    expect(resolveFriendlyMentionsWith('Over to @Done Gate.', lookup)).toBe('Over to <@a:p:dg>.')
    expect(resolveFriendlyMentionsWith('@ana@example.com, @Ana Souza: pick one', lookup)).toBe('<@u:u1>, <@u:u2>: pick one')
    expect(resolveFriendlyMentionsWith('cc @maintainers', lookup)).toBe('cc <@g:g1>')
  })

  test('leaves ambiguous names, partial words, emails, code and existing tokens alone', () => {
    expect(resolveFriendlyMentionsWith('@Ana can you check', lookup)).toBe('@Ana can you check')
    expect(resolveFriendlyMentionsWith('@Analysts are busy', lookup)).toBe('@Analysts are busy')
    expect(resolveFriendlyMentionsWith('mail ana@example.com', lookup)).toBe('mail ana@example.com')
    expect(resolveFriendlyMentionsWith('run `@Analyst` or\n```\n@Done Gate\n```', lookup)).toBe('run `@Analyst` or\n```\n@Done Gate\n```')
    expect(resolveFriendlyMentionsWith('<@a:p:an> already tagged', lookup)).toBe('<@a:p:an> already tagged')
  })
})

describe('scripted channel agents', () => {
  async function replyText(res: Response) {
    const body = await res.text()
    return body.split('\n\n').filter(Boolean)
      .map((f) => JSON.parse(f.replace(/^data: /, '')))
      .filter((e) => e.type === 'text-delta').map((e) => e.delta).join('')
  }

  test('only runs in local mode, never in production', async () => {
    expect(scriptedAgentInvokeFromEnv({ SHOGO_CHANNEL_AGENT_SCRIPT: '/x.json' })).toBeNull()
    expect(scriptedAgentInvokeFromEnv({ SHOGO_CHANNEL_AGENT_SCRIPT: '/x.json', SHOGO_LOCAL_MODE: 'true', NODE_ENV: 'production' })).toBeNull()
    expect(scriptedAgentInvokeFromEnv({ SHOGO_LOCAL_MODE: 'true' })).toBeNull()
    expect(scriptedAgentInvokeFromEnv({ SHOGO_CHANNEL_AGENT_SCRIPT: '/x.json', SHOGO_LOCAL_MODE: 'true' })).toBeFunction()
  })

  test('picks the first rule matching the latest message and fills in the origin mention', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agent-script-')), 'script.json')
    writeFileSync(path, JSON.stringify({
      delayMs: 0,
      agents: { workspace: [{ when: 'option b', reply: 'Going with B.' }, { reply: 'A or B, {{origin}}?' }] },
    }))
    const invoke = scriptedAgentInvokeFromEnv({ SHOGO_CHANNEL_AGENT_SCRIPT: path, SHOGO_LOCAL_MODE: 'true' })!
    const args = { workspaceId: 'w', projectId: null, sessionId: 's', userId: 'u1', signal: new AbortController().signal }
    expect(await replyText(await invoke({ ...args, prompt: 'Option B was mentioned earlier\nAda: what now?' }))).toBe('A or B, <@u:u1>?')
    expect(await replyText(await invoke({ ...args, prompt: 'context\nAda: go with option B' }))).toBe('Going with B.')
  })
})
