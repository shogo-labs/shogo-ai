import { describe, expect, test } from 'bun:test'
import {
  isSlackDirectMessageChannel,
  normalizeSlackMessageEvent,
  parseSlackMessage,
  resolveSlackProject,
  resolveSlackThreadTs,
  type SlackRoutingContext,
} from '../router'

const projects = [
  { id: 'api', name: 'API service', description: 'Backend services' },
  { id: 'web', name: 'Web app', description: 'Frontend application' },
]

function context(overrides: Partial<SlackRoutingContext> = {}): SlackRoutingContext {
  return { message: 'Please investigate the issue', projects, ...overrides }
}

describe('parseSlackMessage', () => {
  test('parses commands and inline options', () => {
    expect(parseSlackMessage('@Shogo project="API service" model=opus fix auth')).toEqual({
      command: { type: 'prompt', prompt: 'fix auth', forceNew: false },
      projectSelector: 'API service',
      options: { project: 'API service', model: 'opus' },
    })
    expect(parseSlackMessage('@Shogo agent start a new agent to refactor billing').command).toEqual({
      type: 'agent',
      prompt: 'to refactor billing',
      forceNew: true,
    })
    expect(parseSlackMessage('@Shogo settings').command.type).toBe('settings')
    expect(parseSlackMessage('@Shogo list my projects').command.type).toBe('list_projects')
  })
})

describe('normalizeSlackMessageEvent', () => {
  test('removes the Shogo mention and preserves thread metadata', () => {
    expect(normalizeSlackMessageEvent({
      type: 'app_mention',
      text: '<@UBOT> fix auth',
      user: 'U123',
      channel: 'C123',
      ts: '1710000000.250',
      thread_ts: '1710000000.100',
    }, 'UBOT')).toEqual({
      text: 'fix auth',
      channelId: 'C123',
      senderId: 'U123',
      timestamp: 1710000000250,
      threadTs: '1710000000.100',
      isMention: true,
    })
    expect(normalizeSlackMessageEvent({
      type: 'message',
      subtype: 'message_changed',
      text: 'ignore',
      user: 'U123',
      channel: 'C123',
    })).toBeNull()
  })
})

describe('resolveSlackProject', () => {
  test('uses explicit project mention first', () => {
    expect(resolveSlackProject(context({ message: 'Fix the web app login', recentProjectId: 'api' }))).toMatchObject({
      project: { id: 'web' },
      reason: 'explicit',
    })
  })

  test('uses recent project before routing rules', () => {
    expect(resolveSlackProject(context({
      recentProjectId: 'web',
      routingRules: [{ keyword: 'issue', projectId: 'api' }],
    })).reason).toBe('recent')
  })

  test('uses routing rule before defaults', () => {
    expect(resolveSlackProject(context({
      routingRules: [{ keyword: 'issue', projectId: 'api' }],
      channelDefaultProjectId: 'web',
    })).project?.id).toBe('api')
  })

  test('uses channel, personal, and workspace defaults in order', () => {
    expect(resolveSlackProject(context({ channelDefaultProjectId: 'web', personalDefaultProjectId: 'api' })).reason).toBe('channel_default')
    expect(resolveSlackProject(context({ personalDefaultProjectId: 'api' })).reason).toBe('personal_default')
    expect(resolveSlackProject(context({ workspaceDefaultProjectId: 'web' })).reason).toBe('workspace_default')
  })

  test('asks for a project when multiple projects remain ambiguous', () => {
    expect(resolveSlackProject(context()).reason).toBe('ambiguous')
    expect(resolveSlackProject(context()).candidates).toHaveLength(2)
  })

  test('falls back to the only available project', () => {
    expect(resolveSlackProject(context({ projects: [projects[0]] })).project?.id).toBe('api')
  })
})

describe('isSlackDirectMessageChannel', () => {
  test('recognizes only the D-prefixed DM convention', () => {
    expect(isSlackDirectMessageChannel('D123')).toBe(true)
    expect(isSlackDirectMessageChannel('C123')).toBe(false)
    expect(isSlackDirectMessageChannel('G123')).toBe(false)
  })
})

describe('resolveSlackThreadTs', () => {
  test('an explicit Slack reply-in-thread always wins', () => {
    expect(resolveSlackThreadTs({
      channelId: 'D1',
      messageThreadTs: '111.000',
      fallbackTs: '222.000',
      forceNew: false,
      activeDmChannelId: 'D1',
      activeDmThreadTs: '333.000',
    })).toBe('111.000')
  })

  test('a fresh top-level DM message continues the running conversation thread', () => {
    expect(resolveSlackThreadTs({
      channelId: 'D1',
      messageThreadTs: undefined,
      fallbackTs: '222.000',
      forceNew: false,
      activeDmChannelId: 'D1',
      activeDmThreadTs: '111.000',
    })).toBe('111.000')
  })

  test('the very first DM message (no prior thread yet) starts a new one', () => {
    expect(resolveSlackThreadTs({
      channelId: 'D1',
      messageThreadTs: undefined,
      fallbackTs: '222.000',
      forceNew: false,
      activeDmChannelId: null,
      activeDmThreadTs: null,
    })).toBe('222.000')
  })

  test('a stored thread for a different DM channel is ignored', () => {
    expect(resolveSlackThreadTs({
      channelId: 'D2',
      messageThreadTs: undefined,
      fallbackTs: '222.000',
      forceNew: false,
      activeDmChannelId: 'D1',
      activeDmThreadTs: '111.000',
    })).toBe('222.000')
  })

  test('forceNew ("agent: ...") always starts a fresh thread even mid-DM-conversation', () => {
    expect(resolveSlackThreadTs({
      channelId: 'D1',
      messageThreadTs: undefined,
      fallbackTs: '222.000',
      forceNew: true,
      activeDmChannelId: 'D1',
      activeDmThreadTs: '111.000',
    })).toBe('222.000')
  })

  test('channel messages (non-DM) always get a fresh thread per mention', () => {
    expect(resolveSlackThreadTs({
      channelId: 'C1',
      messageThreadTs: undefined,
      fallbackTs: '222.000',
      forceNew: false,
      activeDmChannelId: 'C1',
      activeDmThreadTs: '111.000',
    })).toBe('222.000')
  })
})
