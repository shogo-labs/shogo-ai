// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { API_URL } from './api'

export type StartupDiagnosticType = 'sentry_init_failed' | 'sentry_dsn_invalid'

interface StartupDiagnosticInput {
  type: StartupDiagnosticType
  error?: unknown
  message?: string
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? value.slice(0, max) : value
}

function errorFields(error: unknown): { errorName?: string; message?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      errorName: truncate(error.name, 128),
      message: truncate(error.message, 2000),
      stack: truncate(error.stack, 4000),
    }
  }
  if (typeof error === 'string') {
    return { message: truncate(error, 2000) }
  }
  if (typeof error === 'undefined' || error === null) {
    return {}
  }
  return { message: truncate(String(error), 2000) }
}

export function reportStartupDiagnostic(input: StartupDiagnosticInput): void {
  if (!API_URL) return
  const fields = errorFields(input.error)
  const message = input.message ?? fields.message

  void fetch(`${API_URL}/api/client-diagnostics/startup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: input.type,
      platform: Platform.OS,
      appEnv: process.env.EXPO_PUBLIC_APP_ENV || 'development',
      buildHash: process.env.EXPO_PUBLIC_BUILD_HASH || 'dev',
      release: process.env.EXPO_PUBLIC_BUILD_HASH || 'dev',
      occurredAt: new Date().toISOString(),
      ...fields,
      ...(message ? { message } : {}),
    }),
  }).catch(() => {})
}