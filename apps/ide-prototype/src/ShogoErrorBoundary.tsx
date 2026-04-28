// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  showDetails: boolean
}

function reportToParent(error: string, phase: string = 'runtime') {
  if (typeof window === 'undefined' || window.parent === window) return
  try {
    window.parent.postMessage({ type: 'canvas-error', phase, error }, '*')
  } catch {
    // ignore — parent may be cross-origin without listener
  }
}

export class ShogoErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, showDetails: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = error.stack ?? ''
    const componentStack = info.componentStack ?? ''
    reportToParent(`${error.message}\n${stack}\n${componentStack}`.trim())
    console.error('[ShogoErrorBoundary]', error, info)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false })
  }

  handleReload = () => {
    window.location.reload()
  }

  toggleDetails = () => {
    this.setState((s) => ({ showDetails: !s.showDetails }))
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const err = this.state.error
    const message = err?.message ?? 'Unknown error'
    const stack = err?.stack ?? ''

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: 'var(--background, #fafafa)',
          color: 'var(--foreground, #111)',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            maxWidth: '520px',
            width: '100%',
            border: '1px solid var(--border, #e5e5e5)',
            borderRadius: '16px',
            padding: '24px',
            background: 'var(--card, #fff)',
            boxShadow: '0 4px 24px rgba(0, 0, 0, 0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '12px',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'rgba(245, 158, 11, 0.12)',
                color: '#d97706',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '20px',
                fontWeight: 700,
              }}
              aria-hidden
            >
              !
            </div>
            <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
              Something went wrong
            </h1>
          </div>

          <p
            style={{
              fontSize: '14px',
              lineHeight: 1.5,
              color: 'var(--muted-foreground, #666)',
              margin: '0 0 16px 0',
            }}
          >
            The app crashed while rendering. You can try again, or reload the
            page. Shogo has been notified.
          </p>

          <div
            style={{
              fontSize: '13px',
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              padding: '10px 12px',
              borderRadius: '8px',
              background: 'var(--muted, #f4f4f5)',
              color: 'var(--foreground, #111)',
              marginBottom: '12px',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </div>

          {stack && (
            <>
              <button
                type="button"
                onClick={this.toggleDetails}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  fontSize: '12px',
                  color: 'var(--muted-foreground, #666)',
                  cursor: 'pointer',
                  marginBottom: '12px',
                  textDecoration: 'underline',
                }}
              >
                {this.state.showDetails ? 'Hide details' : 'Show details'}
              </button>
              {this.state.showDetails && (
                <pre
                  style={{
                    fontSize: '11.5px',
                    lineHeight: 1.4,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    padding: '12px',
                    borderRadius: '8px',
                    background: 'var(--muted, #f4f4f5)',
                    color: 'var(--foreground, #111)',
                    margin: '0 0 16px 0',
                    overflow: 'auto',
                    maxHeight: '240px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {stack}
                </pre>
              )}
            </>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{
                flex: 1,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '14px',
                fontWeight: 600,
                padding: '10px 16px',
                borderRadius: '10px',
                border: 'none',
                background: 'var(--primary, #111)',
                color: 'var(--primary-foreground, #fff)',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                flex: 1,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '14px',
                fontWeight: 600,
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid var(--border, #e5e5e5)',
                background: 'transparent',
                color: 'var(--foreground, #111)',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
