// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Component, type ReactNode } from 'react'
import { View } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { Text } from '@/components/ui/text'
import { Button, ButtonText } from '@/components/ui/button'
import { AlertTriangle, RefreshCw } from 'lucide-react-native'

interface Props {
  children: ReactNode
  surfaceTitle?: string
  onRetry?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorCount: number
  autoRetrying: boolean
}

const AUTO_RETRY_DELAY_MS = 1500
const MAX_AUTO_RETRIES = 1

/**
 * Error boundary wrapping the Dynamic App canvas renderer.
 * Catches rendering crashes, auto-retries once, then shows manual recovery UI.
 */
export class CanvasErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorCount: 0, autoRetrying: false }
  private autoRetryTimer: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    Sentry.captureException(error, { tags: { boundary: 'canvas' } })
    console.error('[CanvasErrorBoundary] Render crash:', error.message)

    if (this.state.errorCount < MAX_AUTO_RETRIES) {
      this.scheduleAutoRetry()
    }
  }

  componentWillUnmount() {
    if (this.autoRetryTimer) clearTimeout(this.autoRetryTimer)
  }

  private scheduleAutoRetry() {
    this.setState({ autoRetrying: true })
    this.autoRetryTimer = setTimeout(() => {
      this.autoRetryTimer = null
      this.setState(prev => ({
        hasError: false,
        error: null,
        errorCount: prev.errorCount + 1,
        autoRetrying: false,
      }))
    }, AUTO_RETRY_DELAY_MS)
  }

  handleRetry = () => {
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer)
      this.autoRetryTimer = null
    }
    this.setState(prev => ({
      hasError: false,
      error: null,
      errorCount: prev.errorCount + 1,
      autoRetrying: false,
    }))
    this.props.onRetry?.()
  }

  render() {
    if (!this.state.hasError) return this.props.children

    if (this.state.autoRetrying) {
      return (
        <View className="flex-col items-center justify-center min-h-[200px] gap-3 px-8 py-12">
          <RefreshCw size={20} className="text-muted-foreground animate-spin" />
          <Text className="text-sm text-muted-foreground">Recovering canvas...</Text>
        </View>
      )
    }

    return (
      <View className="flex-col items-center justify-center min-h-[200px] gap-4 px-8 py-12">
        <View className="w-14 h-14 rounded-2xl bg-amber-500/10 items-center justify-center">
          <AlertTriangle size={28} className="text-amber-500" />
        </View>
        <View className="gap-1.5 items-center">
          <Text className="text-base font-semibold">Canvas rendering error</Text>
          <Text className="text-sm text-muted-foreground text-center max-w-[300px]">
            Something went wrong while rendering the canvas. Your data is safe.
          </Text>
        </View>
        <Button action="primary" variant="solid" size="sm" onPress={this.handleRetry}>
          <ButtonText>Retry</ButtonText>
        </Button>
        {this.state.errorCount > 0 && (
          <Text className="text-xs text-muted-foreground">Retry attempt {this.state.errorCount}</Text>
        )}
      </View>
    )
  }
}
