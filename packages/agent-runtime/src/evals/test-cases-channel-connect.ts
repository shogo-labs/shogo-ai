// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel Connect Eval Test Cases
 *
 * Tests the agent's ability to use channel_connect, handle missing config
 * (relaying setup guides to the user), and successfully connect channels
 * when all required config is provided.
 */

import type { AgentEval } from './types'
import { usedTool, toolCallArgsContain, responseContains } from './eval-helpers'

export const CHANNEL_CONNECT_EVALS: AgentEval[] = [
  {
    id: 'channel-connect-telegram-missing-token',
    name: 'Channel: Relay Telegram setup guide when token missing',
    category: 'channel-connect',
    level: 2,
    input: 'Connect me to Telegram so I can chat with this agent from my phone.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-channel-connect',
        description: 'Attempted channel_connect for telegram',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'channel_connect') && toolCallArgsContain(r, 'channel_connect', 'telegram'),
      },
      {
        id: 'mentions-botfather',
        description: 'Response mentions BotFather (from setup guide)',
        points: 25,
        phase: 'execution',
        validate: (r) => responseContains(r, 'botfather') || responseContains(r, 'bot father'),
      },
      {
        id: 'mentions-token',
        description: 'Response tells user they need a bot token',
        points: 25,
        phase: 'execution',
        validate: (r) => responseContains(r, 'token'),
      },
      {
        id: 'actionable-steps',
        description: 'Response includes actionable setup steps (not just "missing config")',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('step') || text.includes('1.') || text.includes('first')) &&
            (text.includes('create') || text.includes('copy') || text.includes('open'))
        },
      },
    ],
  },

  {
    id: 'channel-connect-telegram-with-token',
    name: 'Channel: Connect Telegram with provided token',
    category: 'channel-connect',
    level: 2,
    input: 'Set up Telegram for this agent. My bot token is 7481923456:AAF-xR2mK9vPqLz8sJdW3tYcNbHgE5iUoAk',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-channel-connect',
        description: 'Called channel_connect',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'channel_connect'),
      },
      {
        id: 'correct-type',
        description: 'Used type "telegram"',
        points: 20,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'channel_connect', 'telegram'),
      },
      {
        id: 'included-token',
        description: 'Passed the bot token in config',
        points: 25,
        phase: 'execution',
        validate: (r) => toolCallArgsContain(r, 'channel_connect', '7481923456'),
      },
      {
        id: 'confirms-success',
        description: 'Agent confirms channel was connected/configured',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('connect') || text.includes('configured') || text.includes('set up') || text.includes('ready')
        },
      },
    ],
  },

  {
    id: 'channel-connect-discord-missing-config',
    name: 'Channel: Relay Discord setup guide when config missing',
    category: 'channel-connect',
    level: 2,
    input: 'I want to add this agent to my Discord server. How do we do that?',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-channel-connect-or-explained',
        description: 'Either attempted channel_connect for discord or explained setup',
        points: 30,
        phase: 'intention',
        validate: (r) => {
          const triedConnect = usedTool(r, 'channel_connect') && toolCallArgsContain(r, 'channel_connect', 'discord')
          const explainedSetup = responseContains(r, 'discord') && responseContains(r, 'bot')
          return triedConnect || explainedSetup
        },
      },
      {
        id: 'mentions-developer-portal',
        description: 'Response mentions Discord developer portal or application setup',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('developer') || text.includes('application') || text.includes('portal')
        },
      },
      {
        id: 'mentions-guild-id',
        description: 'Response mentions server/guild ID requirement',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('server id') || text.includes('guild')
        },
      },
      {
        id: 'mentions-token-needed',
        description: 'Response mentions bot token requirement',
        points: 25,
        phase: 'execution',
        validate: (r) => responseContains(r, 'token'),
      },
    ],
  },

  {
    id: 'channel-connect-webchat-easy',
    name: 'Channel: Connect webchat with no external config needed',
    category: 'channel-connect',
    level: 1,
    input: 'Add a chat widget to my website so visitors can talk to this agent.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-channel-connect',
        description: 'Called channel_connect with type webchat',
        points: 35,
        phase: 'intention',
        validate: (r) => usedTool(r, 'channel_connect') && toolCallArgsContain(r, 'channel_connect', 'webchat'),
      },
      {
        id: 'confirms-setup',
        description: 'Agent confirms the widget was set up',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('widget') || text.includes('chat') || text.includes('embed') || text.includes('script')
        },
      },
      {
        id: 'provides-embed',
        description: 'Response includes embed snippet or instructions for the user',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('<script') || text.includes('embed') || text.includes('paste') || text.includes('snippet')
        },
      },
    ],
  },

  {
    id: 'channel-connect-invalid-type',
    name: 'Channel: Handle unsupported channel type gracefully',
    category: 'channel-connect',
    level: 1,
    input: 'Connect my agent to LINE messenger.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-crash',
        description: 'Agent responds without erroring out',
        points: 30,
        phase: 'execution',
        validate: (r) => r.responseText.length > 20,
      },
      {
        id: 'mentions-supported',
        description: 'Agent lists or mentions supported channels',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const mentionedChannels = ['telegram', 'discord', 'slack', 'email', 'webhook', 'webchat'].filter(c => text.includes(c))
          return mentionedChannels.length >= 2
        },
      },
      {
        id: 'explains-limitation',
        description: 'Agent explains LINE is not supported',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('not supported') || text.includes('not available') ||
            text.includes('don\'t support') || text.includes('doesn\'t support') ||
            text.includes('isn\'t supported') || text.includes('not currently') ||
            text.includes('webhook') // suggesting webhook as alternative
        },
      },
    ],
  },
]
