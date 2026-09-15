// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface LiveAudioConfig {
  format?: { type: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma'; rate: number }
  output?: { voice?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface LiveResponsesDelegation {
  model: string
  instructions?: string
  tools?: unknown[]
  tool_choice?: unknown
  [key: string]: unknown
}

export interface LiveSessionConfig {
  model: string
  instructions?: string
  audio?: LiveAudioConfig
  input?: unknown
  store?: boolean
  delegation?: {
    type: 'responses' | 'client'
    responses?: LiveResponsesDelegation
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface LiveSessionStartedEvent {
  type: 'session.started'
  session: { id: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface LiveSessionUsageUpdatedEvent {
  type: 'session.usage.updated'
  usage: { seconds: number; [key: string]: unknown }
  [key: string]: unknown
}

export interface LiveSessionClosedEvent {
  type: 'session.closed'
  usage?: { seconds?: number; [key: string]: unknown }
  [key: string]: unknown
}

export interface LiveErrorEvent {
  type: 'error'
  error?: { message?: string; code?: string; [key: string]: unknown }
  [key: string]: unknown
}

export type LiveSessionEvent =
  | LiveSessionStartedEvent
  | LiveSessionUsageUpdatedEvent
  | LiveSessionClosedEvent
  | LiveErrorEvent
  | {
      type: 'session.output_audio.delta' | 'session.input_transcript.delta' | 'session.output_transcript.delta'
      delta?: string
      [key: string]: unknown
    }
  | {
      type: 'response.event'
      event?: Record<string, unknown>
      [key: string]: unknown
    }
  | Record<string, unknown>

export interface LiveWebRtcSession {
  session: { id: string; [key: string]: unknown }
  transport: { type?: string; sdp: string; [key: string]: unknown }
  [key: string]: unknown
}
