// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { View } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { Text } from '@/components/ui/text'
import { Button, ButtonText } from '@/components/ui/button'
import { AlertTriangle, RefreshCw } from 'lucide-react-native'

interface Props {
  children: ReactNode
  panelName: string
  onRetry?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  autoRetrying: boolean
}

const AUTO_RETRY_DELAY_MS = 1500
/**
 * Runaway-render bugs ("Maximum update depth exceeded") often need a longer
 * settle window — the upstream state mutation that triggered the loop may
 * still be flushing when we mount the fresh subtree. A short delay here just
 * causes the new tree to crash again immediately.
 */
const RENDER_STORM_RETRY_DELAY_MS = 2500
const MAX_AUTO_RETRIES_IN_WINDOW = 3
const BURST_WINDOW_MS = 15_000

const RENDER_STORM_PATTERNS = [
  /Maximum update depth exceeded/i,
  /Too many re-renders/i,
]

function isRenderStorm(error: Error): boolean {
  const msg = error?.message ?? ''
  return RENDER_STORM_PATTERNS.some((re) => re.test(msg))
}

/**
 * Scoped error boundary for project panels (Chat, IDE, Terminal, etc.).
 *
 * Strategy: every render crash auto-retries by remounting the subtree (which
 * resets all of the panel's local state — useState, useRef, useChat, etc.).
 * We use a sliding burst window: if more than `MAX_AUTO_RETRIES_IN_WINDOW`
 * crashes happen within `BURST_WINDOW_MS`, we stop and show manual recovery
 * UI so we don't loop forever on a deterministic bug.
 *
 * Each instance is independent — a crash in one panel does not affect others.
 * Sentry still captures every crash, so the diagnostic stack is never lost.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, autoRetrying: false }
  private autoRetryTimer: ReturnType<typeof setTimeout> | null = null
  /** Timestamps of recent crashes; trimmed to a sliding window on each crash. */
  private recentCrashTimes: number[] = []

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentStack = info?.componentStack ?? null
    Sentry.captureException(error, {
      tags: { boundary: 'panel', renderStorm: String(isRenderStorm(error)) },
      extra: {
        panelName: this.props.panelName,
        componentStack,
      },
    })
    console.error(
      `[PanelErrorBoundary:${this.props.panelName}] Render crash: ${error.message}` +
        (componentStack ? `\nComponent stack:${componentStack}` : ''),
    )

    const now = Date.now()
    this.recentCrashTimes = this.recentCrashTimes.filter(t => now - t < BURST_WINDOW_MS)
    this.recentCrashTimes.push(now)

    if (this.recentCrashTimes.length > MAX_AUTO_RETRIES_IN_WINDOW) {
      // The remount keeps crashing — the bug is deterministic in the current
      // state. Stop auto-retrying so we don't burn CPU and so the user can
      // intervene (manual retry will reset the burst counter).
      return
    }

    this.scheduleAutoRetry(isRenderStorm(error))
  }

  componentWillUnmount() {
    if (this.autoRetryTimer) clearTimeout(this.autoRetryTimer)
  }

  private scheduleAutoRetry(longDelay: boolean) {
    this.setState({ autoRetrying: true })
    this.autoRetryTimer = setTimeout(() => {
      this.autoRetryTimer = null
      this.setState({ hasError: false, error: null, autoRetrying: false })
    }, longDelay ? RENDER_STORM_RETRY_DELAY_MS : AUTO_RETRY_DELAY_MS)
  }

  handleRetry = () => {
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer)
      this.autoRetryTimer = null
    }
    // A manual retry is the user's signal to forget the burst history — they
    // may have just fixed something, or enough time may have passed that the
    // bad state is gone. Either way, give auto-recovery a fresh budget.
    this.recentCrashTimes = []
    this.setState({ hasError: false, error: null, autoRetrying: false })
    this.props.onRetry?.()
  }

  render() {
    if (this.state.autoRetrying) {
      return (
        <View className="flex-1 flex-col items-center justify-center gap-3 px-8 py-12">
          <RefreshCw size={20} className="text-muted-foreground animate-spin" />
          <Text className="text-sm text-muted-foreground">
            Recovering {this.props.panelName}...
          </Text>
        </View>
      )
    }

    if (this.state.hasError) {
      return (
        <View className="flex-1 flex-col items-center justify-center gap-4 px-8 py-12">
          <View className="w-14 h-14 rounded-2xl bg-amber-500/10 items-center justify-center">
            <AlertTriangle size={28} className="text-amber-500" />
          </View>
          <View className="gap-1.5 items-center">
            <Text className="text-base font-semibold">
              {this.props.panelName} encountered an error
            </Text>
            <Text className="text-sm text-muted-foreground text-center max-w-[300px]">
              Something went wrong. Your data is safe.
            </Text>
          </View>
          <Button
            action="primary"
            variant="solid"
            size="sm"
            onPress={this.handleRetry}
            accessibilityLabel={`Retry ${this.props.panelName}`}
          >
            <ButtonText>Retry</ButtonText>
          </Button>
        </View>
      )
    }

    // Children mount fresh after every recovery: while `hasError` /
    // `autoRetrying` was true we rendered the fallback UI instead of the
    // children, so React unmounted them — the next render here is a clean
    // mount with new useState / refs / useChat instances.
    return this.props.children
  }
}
