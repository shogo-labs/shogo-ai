import { Component, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
 * Catches React Error #31 and similar rendering crashes.
 * Auto-retries once (likely transient), then shows manual recovery UI.
 */
export class CanvasErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorCount: 0, autoRetrying: false }
  private autoRetryTimer: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[CanvasErrorBoundary] Render crash:', error.message)
    console.error('[CanvasErrorBoundary] Component stack:', info.componentStack)

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

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children

    if (this.state.autoRetrying) {
      return (
        <div className="flex flex-col items-center justify-center h-full min-h-[200px] gap-3 px-8 py-12 text-center">
          <RefreshCw className="size-5 text-muted-foreground animate-spin" />
          <p className="text-sm text-muted-foreground">Recovering canvas...</p>
        </div>
      )
    }

    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] gap-4 px-8 py-12 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 flex items-center justify-center">
          <AlertTriangle className="size-7 text-amber-500" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-base font-semibold">Canvas rendering error</h3>
          <p className="text-sm text-muted-foreground max-w-md">
            Something went wrong while rendering the canvas. Your data is safe.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="default" size="sm" onClick={this.handleRetry} className="gap-2">
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
          <Button variant="outline" size="sm" onClick={this.handleReload}>
            Reload page
          </Button>
        </div>
        {this.state.errorCount > 0 && (
          <p className="text-xs text-muted-foreground">Retry attempt {this.state.errorCount}</p>
        )}
      </div>
    )
  }
}
