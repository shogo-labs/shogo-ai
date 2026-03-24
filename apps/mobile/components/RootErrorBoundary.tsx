// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Component, type ReactNode } from 'react'
import { Platform, View, Text, Pressable, StyleSheet } from 'react-native'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#09090b',
    padding: 24,
  },
  card: {
    maxWidth: 400,
    width: '100%',
    backgroundColor: '#18181b',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#27272a',
    padding: 32,
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fafafa',
    textAlign: 'center',
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    color: '#a1a1aa',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  detail: {
    fontSize: 12,
    color: '#71717a',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 12,
  },
  button: {
    marginTop: 8,
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
})

/**
 * Top-level error boundary wrapping the entire React tree.
 * Prevents unhandled render errors from leaving the user with a blank
 * white screen by catching the throw and showing a recovery UI.
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[RootErrorBoundary] Unhandled render error:', error.message, info.componentStack)
  }

  handleReload = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.location.reload()
    } else {
      this.setState({ hasError: false, error: null })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            An unexpected error occurred. Please reload the page.
          </Text>
          {this.state.error && (
            <Text style={styles.detail} numberOfLines={3}>
              {this.state.error.message}
            </Text>
          )}
          <Pressable
            style={styles.button}
            onPress={this.handleReload}
            accessibilityLabel="Reload the application"
          >
            <Text style={styles.buttonText}>Reload</Text>
          </Pressable>
        </View>
      </View>
    )
  }
}
