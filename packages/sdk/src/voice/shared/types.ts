// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared option / result types for `useVoiceConversation` across
 * platforms. The web hook ([packages/sdk/src/voice/react]) and the
 * native hook ([packages/sdk/src/voice/native]) both export their own
 * `UseVoiceConversationOptions` / `UseVoiceConversationResult`
 * types — typically by re-exporting `BaseVoiceConversationOptions` /
 * `BaseVoiceConversationResult` from this module — so consumers can
 * import them from whichever subpath they're using.
 */

export interface BaseVoiceConversationOptions {
  /** Name of the companion the user is talking to (passed as a dynamic variable). */
  characterName: string

  /** Server path that mints an 11Labs signed URL for this user. Default: `/api/voice/signed-url`. */
  signedUrlPath?: string

  /** Server path the built-in `add_memory` tool POSTs to. Default: `/api/memory/add`. */
  memoryAddPath?: string

  /** Server path used to auto-inject memory context. Default: `/api/memory/retrieve`. */
  memoryRetrievePath?: string

  /** Server path the transcript is POSTed to when the session ends. Default: `/api/memory/ingest`. */
  transcriptIngestPath?: string

  /** Disable the built-in memory context auto-injection. Default: `true` (enabled). */
  autoInjectMemory?: boolean

  /** Disable the built-in `add_memory` client tool. Default: `true` (enabled). */
  includeMemoryTool?: boolean

  /**
   * Additional client tools merged onto `add_memory`. Tools defined here with
   * the name `add_memory` override the built-in implementation.
   */
  clientTools?: Record<string, (params: Record<string, unknown>) => Promise<string> | string>

  /**
   * Called once per session with the accumulated transcript when the session
   * disconnects. Defaults to POST `transcriptIngestPath`; set this to suppress
   * or replace that behaviour.
   */
  onTranscript?: (transcript: string) => void | Promise<void>

  /**
   * Credentials mode for built-in fetch calls.
   *
   * - Defaults to `same-origin` in the legacy cookie path.
   * - Defaults to `omit` when `shogoApiKey` is provided (bearer auth is
   *   self-contained and you don't want browsers to attach unrelated
   *   third-party cookies cross-origin).
   * - Explicit values always win — pass `'include'` to carry both a cookie
   *   and the bearer in a hybrid same-origin app.
   */
  fetchCredentials?: RequestCredentials

  /**
   * Shogo API key (`shogo_sk_*`) used to authenticate voice routes. When
   * provided, the hook attaches `Authorization: Bearer <key>` to the
   * signed-URL fetch and memory fetches, and appends `?projectId=` to
   * the signed-URL path. Either `shogoApiKey` or a session cookie must
   * be resolvable by the server — both may be passed; the server's
   * `apiKeyOrSession` middleware picks bearer first.
   */
  shogoApiKey?: string

  /**
   * Project id (Shogo's `projectId`). Required alongside `shogoApiKey`
   * for Mode B voice. The server uses it to look up / provision the
   * project's ElevenLabs agent and resolve the workspace.
   */
  projectId?: string

  /** Called on connection errors. */
  onError?: (error: unknown) => void

  /** Called on each message (user or agent) for debugging / custom UI. */
  onMessage?: (message: { source: string; message: string }) => void
}

export interface BaseVoiceConversationResult {
  /**
   * Begin a new session. Requests microphone permission and fetches a
   * signed URL.
   *
   * `suppressFirstMessage` mirrors the option on `restart()` — when
   * `true`, the new session is opened with `overrides.agent.firstMessage = ''`
   * so the agent skips its opening greeting. Useful when the consumer
   * is programmatically reconnecting (e.g. to deliver a one-shot spoken
   * summary) and does not want to hear the configured intro.
   */
  start: (options?: { suppressFirstMessage?: boolean }) => Promise<void>
  /** End the current session (if any). */
  end: () => void
  /**
   * Tear down the active session and immediately reconnect. Primarily
   * used as a programmatic barge-in: ElevenLabs doesn't expose a public
   * `interrupt()` on `useConversation`, so stopping the agent mid-
   * utterance requires a fast disconnect + reconnect. When
   * `suppressFirstMessage` is `true` (the default), the new session is
   * started with `overrides.agent.firstMessage = ''` so the agent does
   * not replay its intro. The accumulated transcript is preserved
   * across the reconnect gap.
   */
  restart: (options?: { suppressFirstMessage?: boolean }) => Promise<void>
  /** `'disconnected' | 'connecting' | 'connected'`. */
  status: 'disconnected' | 'connecting' | 'connected'
  /** Whether the agent is currently speaking. */
  isSpeaking: boolean
  /** Whether the agent is currently listening. */
  isListening: boolean
  /** Whether the microphone is currently muted (input audio is gated off). */
  isMuted: boolean
  /**
   * Toggle the microphone mute state without tearing down the session.
   * Wraps `@elevenlabs/react` (or `@elevenlabs/react-native`)'s
   * `setMuted`, which in turn calls `conversation.setMicMuted()`.
   * Muting does not end the WebSocket or release the underlying media
   * stream; it simply stops input audio from being forwarded to the
   * server.
   */
  setMuted: (isMuted: boolean) => void
  /** For consumers who want to drive their own visualisation / lipsync. */
  getOutputByteFrequencyData: () => Uint8Array | null
  /** Imperatively send a contextual update (e.g. "user navigated to X"). */
  sendContextualUpdate: (text: string) => void
  /**
   * Imperatively inject a user-role message, forcing the agent to take
   * its next turn immediately (rather than waiting for the human to
   * speak). Useful for out-of-band prompts like "please summarise what
   * just happened". The injected text is *not* spoken aloud — the agent
   * treats it as if the user said it.
   */
  sendUserMessage: (text: string) => void
  /**
   * Low-level signal that the user is active (typing, clicking) so the
   * agent doesn't try to fill silence. Used as a fallback nudge when we
   * want to keep the session "warm" without forcing a full turn.
   */
  sendUserActivity: () => void
}
