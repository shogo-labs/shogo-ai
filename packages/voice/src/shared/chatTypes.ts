// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared option / result types for `useChatConversation` across
 * platforms.
 *
 * The text-chat hook is the audio-free sibling of
 * `useVoiceConversation` (see `./types.ts`): it talks to the same
 * underlying agent persona, reuses the same auth surface
 * (`shogoApiKey` + `projectId` or session cookie), and exposes the
 * same client-tool registration shape — but the wire transport is a
 * plain streaming HTTP POST instead of an ElevenLabs Convai WebSocket.
 *
 * Why a separate `Base*ChatConversation*` instead of overloading the
 * voice option types: the audio-vs-text wire differences (no
 * `signedUrlPath`, no transcript persistence flush, no
 * `firstMessage`/`characterName` dynamic variables, no `setMuted`,
 * etc.) are large enough that conflating them produces a worse public
 * API. Instead, both `Base*` shapes deliberately share the auth /
 * `projectId` / `conversationId` fields verbatim so consumers can
 * thread a single config object through both hooks in a "shared
 * agent, two transports" app — see `packages/sdk/README.md` §"Voice
 * + text bridge" for the canonical pattern.
 *
 * Web (`packages/sdk/src/voice/react/useChatConversation.ts`) and
 * native (`packages/sdk/src/voice/native/useChatConversation.ts`) both
 * re-export `BaseChatConversation*` as their own concrete option /
 * result types so consumers can import whichever subpath matches
 * their platform without crossing the platform boundary.
 */
import type { UIMessage } from 'ai'

/**
 * Tool implementation surface accepted by `useChatConversation`.
 * Mirrors `ClientToolFn` in `./memory.ts` (which the voice hook uses)
 * so the same tool map drops cleanly into both hooks.
 *
 * Tools are resolved client-side: the server route declares each tool
 * WITHOUT an `execute` function, the model produces a tool-call event,
 * and the hook calls into this map and POSTs the result back via
 * `addToolOutput`. Any returned string is forwarded to the agent as
 * the tool result; thrown errors are surfaced as `output-error`.
 */
export type ChatClientToolFn = (
  params: Record<string, unknown>,
) => string | Promise<string>

/** Status surface mirroring `@ai-sdk/react`'s `useChat().status`. */
export type ChatConversationStatus =
  | 'ready'
  | 'submitted'
  | 'streaming'
  | 'error'

/**
 * Per-tool wire spec sent to the server as part of the request body.
 *
 * The server re-declares each tool to the model so it can produce
 * tool-call events. Unlike voice (where the agent is provisioned with
 * its tools server-side once), text consumers register tools per
 * client because the same agent prompt may want to drive different
 * client-resident effects on different surfaces. We accept a
 * JSON-Schema-shaped descriptor here — the SDK does not depend on
 * `zod` so consumers are free to write the schemas inline.
 *
 * The server validates the descriptor before passing it to the model
 * and rejects unknown shapes; see `apps/api/src/routes/chat.ts`.
 */
export interface ChatToolDescriptor {
  /** Stable tool name (must match the key under `clientTools`). */
  name: string
  /** Free-form description handed to the model. */
  description: string
  /**
   * JSON Schema for the tool's input. Keep this small — long schemas
   * inflate every turn's prompt. `type: 'object'` with a flat
   * `properties` map covers ~all real cases.
   */
  inputSchema: Record<string, unknown>
}

export interface BaseChatConversationOptions {
  /**
   * Streaming chat endpoint URL. Defaults to `'/api/chat/turn'` (the
   * route shipped in `apps/api`). Override to point at a custom
   * deployment or to embed query params other than `projectId` /
   * `conversationId`.
   *
   * The hook appends `?projectId=` and `?conversationId=` to whatever
   * value is supplied here, so a `?foo=bar` already on the URL is
   * preserved.
   */
  api?: string

  /**
   * Shogo API key (`shogo_sk_*`). When set, attached as
   * `Authorization: Bearer <key>` on every request and
   * `?projectId=` is appended. Mirrors the option of the same name
   * on `BaseVoiceConversationOptions`.
   */
  shogoApiKey?: string

  /**
   * Project id. Required when `shogoApiKey` is set so the server can
   * resolve the project's persona prompt, memory, and tool allowlist.
   * Mirrors `BaseVoiceConversationOptions.projectId`.
   */
  projectId?: string

  /**
   * Optional named agent to converse with. Appended to the chat URL
   * as `?agentName=` and resolved server-side to a project-scoped
   * `ProjectAgent` row whose `systemPrompt` / `model` / tool
   * allowlist drive this turn. When omitted, the server resolves the
   * project's `default` agent (or falls back to its built-in
   * persona for projects predating the agents table).
   *
   * The same `agentName` reaches the same persona via
   * `useVoiceConversation({ agentName })` — voice and chat are two
   * transports for one agent record.
   */
  agentName?: string

  /**
   * Stable conversation id used by the consumer to correlate this
   * text thread with a sibling voice session (see
   * `BaseVoiceConversationResult.conversationId`). The value is
   * forwarded to the server in the request body so durable transcripts
   * land under the same row, and is appended to the URL as
   * `?conversationId=` for log correlation.
   *
   * Optional — if omitted, the server treats each turn as a free-
   * standing thread (state-via-`messages`-array). Most consumers want
   * to set this to keep voice + text under one logical conversation.
   */
  conversationId?: string

  /**
   * Initial messages used to seed the in-memory thread on first
   * mount. Useful for cross-modality merging (e.g. seed with the
   * voice transcript before opening text), prefilling a greeting, or
   * resuming a stored thread. Forwarded to `useChat({ messages })`.
   *
   * Subsequent updates should go through `setMessages(...)` on the
   * returned hook surface — changing `initialMessages` after first
   * render does NOT replay them.
   */
  initialMessages?: UIMessage[]

  /**
   * Client-side tool implementations keyed by tool name. The
   * companion `tools` descriptor list is what the server registers
   * with the model on each turn; the keys must match.
   */
  clientTools?: Record<string, ChatClientToolFn>

  /**
   * Tool descriptors forwarded to the server in the request body.
   * Empty / undefined ships the request without any tools (the
   * server's default agent persona still runs, just with no tool
   * surface). Required when `clientTools` is non-empty — the server
   * needs both halves to declare the tool to the model.
   */
  tools?: ChatToolDescriptor[]

  /**
   * Credentials mode for `fetch`. Defaults to `'same-origin'` on
   * web (matches `useShogoVoice`), `'omit'` on native when
   * `shogoApiKey` is set or `'include'` otherwise (matches
   * `useShogoVoice` native defaults).
   */
  fetchCredentials?: RequestCredentials

  /**
   * Stable id forwarded to `useChat({ id })`. Only used to keep the
   * AI-SDK chat instance keyed across re-renders / route changes; not
   * sent on the wire. Defaults to a value derived from
   * `conversationId` (or a per-mount fallback).
   */
  id?: string

  /** Called on transport / model errors. */
  onError?: (error: unknown) => void

  /**
   * Per-user dynamic variables forwarded with each chat turn. Mirrors
   * the option of the same name on `BaseVoiceConversationOptions` so a
   * single config object can drive both hooks.
   *
   * V1 plumbs this through to the request body — server-side rendering
   * into the system prompt is not yet wired up. Treat it as forwards-
   * compatible: setting the value today is safe and lets the server
   * pick it up once support lands without a SDK bump.
   */
  dynamicVariables?: Record<string, unknown> | null
}

export interface BaseChatConversationResult {
  /** Live message list mirroring `useChat().messages`. */
  messages: UIMessage[]

  /**
   * Send a new user turn. Resolves once the request leaves the
   * client; the returned promise does NOT wait for the assistant
   * stream to finish — observe `messages` / `status` for that.
   */
  sendMessage: (text: string) => Promise<void>

  /**
   * Replace the current in-memory thread. Useful for hydrating from
   * a persisted store, seeding with a sibling voice transcript, or
   * surgically rewriting an earlier turn. Forwarded directly to
   * `useChat().setMessages`.
   */
  setMessages: (messages: UIMessage[]) => void

  /**
   * Append a synthetic assistant message without making a model
   * call. Use for prefilling a deterministic first-turn greeting,
   * surfacing a heartbeat from a sibling voice session as if the
   * agent had spoken it, etc. Generates an id locally; the message
   * is NOT echoed to the server.
   */
  appendAssistantMessage: (text: string) => void

  /**
   * Append a synthetic user message without dispatching a turn.
   * Symmetric counterpart to `appendAssistantMessage` — useful for
   * merging a voice transcript turn into the text thread without
   * round-tripping through the model.
   */
  appendUserMessage: (text: string) => void

  /** Current request lifecycle. See `ChatConversationStatus`. */
  status: ChatConversationStatus

  /**
   * The `conversationId` the hook is currently using. Returns the
   * caller-supplied option verbatim, or `null` when none was set.
   * Provided so a single bridge component can read the value from
   * either hook without juggling default-vs-override logic.
   */
  conversationId: string | null
}
