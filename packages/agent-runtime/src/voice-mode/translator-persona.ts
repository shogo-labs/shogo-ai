// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Mode translator persona — single source of truth.
 *
 * Shogo sits between a business user (who speaks plain English) and the
 * technical chat agent (which speaks code, file paths, and diffs). It has
 * two tools to actually drive the chat UI on the user's behalf:
 *
 *   - `send_to_chat(text)` — send a natural-language instruction.
 *   - `set_mode(mode)`     — toggle between `'agent'` and `'plan'`.
 *
 * This module exposes the prompt and tool specs in two shapes so the same
 * persona can be provisioned as:
 *
 *   - an ElevenLabs convai agent (voice modality), and
 *   - a streaming AI-SDK chat endpoint (text modality).
 *
 * No imports from runtime/server code so it can be used by the creation
 * script, `apps/api` (text route), and tests alike.
 */

import type { ConvaiClientTool } from '@shogo-ai/sdk/voice'
import { z } from 'zod'

export const TRANSLATOR_SYSTEM_PROMPT = `You are Shogo, a friendly concierge that sits between a business user and a separate, technical AI agent that actually operates the Shogo IDE. The user speaks plain English; the technical agent speaks code, file paths, and diffs.

Your job has three parts:

1. When the user asks for something, briefly confirm intent in one sentence, then call the \`send_to_chat\` tool with a clear natural-language instruction for the technical agent. Do NOT include code, file paths, or IDs in what you send — describe the outcome the user wants. Do not send until the user's intent is clear; it is OK to ask one clarifying question first.

2. If the user wants to explore or review before executing, call \`set_mode\` with \`"plan"\` before sending. For straight execution, use \`"agent"\`. Only switch modes when the user's intent clearly implies it.

3. When the technical agent replies, it arrives as a message that starts with \`The agent replied:\`. Paraphrase that reply in plain, conversational business language — strip jargon, file paths, identifiers, and code blocks. Keep replies short (two or three sentences). If it failed, say so simply and suggest the next step.

Style: warm, calm, concise. No emoji. Never read raw code or path names aloud.`

/**
 * Zod parameter schemas — the canonical definition. Both the ElevenLabs and
 * AI-SDK tool shapes below are generated from these.
 */
export const SEND_TO_CHAT_PARAMS = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      'A clear natural-language instruction for the technical agent, in the user\'s voice. No code, file paths, or identifiers — describe the outcome.',
    ),
})

export const SET_MODE_PARAMS = z.object({
  mode: z
    .enum(['agent', 'plan'])
    .describe(
      'The chat interaction mode. "plan" for explore/review before executing; "agent" for direct execution.',
    ),
})

export type SendToChatArgs = z.infer<typeof SEND_TO_CHAT_PARAMS>
export type SetModeArgs = z.infer<typeof SET_MODE_PARAMS>

/**
 * ElevenLabs client-tool descriptors — ready to pass as `tools` on
 * `ElevenLabsClient.createAgent({ ... })`. ElevenLabs uses OpenAPI-ish JSON
 * Schema for parameter shapes; the tool itself is `type: 'client'` so the
 * browser actually executes it.
 */
export const TRANSLATOR_ELEVENLABS_TOOLS: ReadonlyArray<ConvaiClientTool> = [
  {
    type: 'client',
    name: 'send_to_chat',
    description:
      'Send a natural-language instruction to the technical chat agent on the user\'s behalf. Call this after confirming intent.',
    expects_response: true,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'A clear natural-language instruction for the technical agent, in the user\'s voice. No code, file paths, or identifiers.',
        },
      },
      required: ['text'],
    },
  },
  {
    type: 'client',
    name: 'set_mode',
    description:
      'Toggle the chat interaction mode. Use "plan" when the user wants to explore or review before executing, "agent" for direct execution.',
    expects_response: true,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['agent', 'plan'],
          description:
            'The new mode. "plan" for explore/review, "agent" for direct execution.',
        },
      },
      required: ['mode'],
    },
  },
]

/**
 * AI-SDK tool definitions for `streamText({ tools })`. The tool execution
 * itself happens in the browser (the translator has no server-side effects);
 * the server just declares the tool so the model produces a tool call, and
 * the browser's `useChat` hook routes the call back via `addToolOutput`.
 *
 * We leave `execute` unset on purpose — this makes the AI SDK treat it as
 * a "client-side" tool, streaming a `tool-call` event to the UI without
 * running any server handler.
 */
export const TRANSLATOR_AI_SDK_TOOLS = {
  send_to_chat: {
    description:
      'Send a natural-language instruction to the technical chat agent on the user\'s behalf. Call this after confirming intent.',
    inputSchema: SEND_TO_CHAT_PARAMS,
  },
  set_mode: {
    description:
      'Toggle the chat interaction mode. Use "plan" to explore or review before executing, "agent" for direct execution.',
    inputSchema: SET_MODE_PARAMS,
  },
} as const

export type TranslatorToolName = keyof typeof TRANSLATOR_AI_SDK_TOOLS

export const TRANSLATOR_FIRST_MESSAGE =
  'Hi, I\'m Shogo. Tell me what you\'d like to work on, and I\'ll handle the technical details.'
