// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NotificationStack — VS Code-style notification toast system.
 *
 * Replaces the single-toast pattern with a stack of notifications that
 * can be dismissed, have actions, and auto-expire. Follows VS Code's
 * notification UX: bottom-right corner, slide-up animation, optional
 * action buttons, and a "Do Not Disturb" mode.
 *
 * Usage:
 *   const { notify, dismiss, clearAll } = useNotifications()
 *   notify({ title: 'Build complete', message: 'Built in 244ms', type: 'info' })
 *   notify({ title: 'Error', message: 'Failed to compile', type: 'error', actions: [{ label: 'Show', onClick: ... }] })
 */

import { useState, useCallback, useRef, useEffect, createContext, useContext, type ReactNode } from 'react'
import { Platform, View, StyleSheet, Animated, TouchableOpacity, Text } from 'react-native'

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface NotificationAction {
  label: string
  onClick: () => void
}

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message?: string
  actions?: NotificationAction[]
  timestamp: number
  dismissed?: boolean
}

interface NotificationContextValue {
  notifications: Notification[]
  notify: (opts: Omit<Notification, 'id' | 'timestamp'>) => string
  dismiss: (id: string) => void
  clearAll: () => void
  /** When true, non-error notifications are suppressed. */
  dndMode: boolean
  setDndMode: (v: boolean) => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider')
  return ctx
}

const MAX_VISIBLE = 5
const AUTO_DISMISS_MS: Record<NotificationType, number> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  error: 0, // errors don't auto-dismiss
}

let notifIdCounter = 0
function nextId(): string {
  return `notif-${++notifIdCounter}-${Date.now()}`
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [dndMode, setDndMode] = useState(false)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, dismissed: true } : n)))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    // Remove from DOM after animation
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id))
    }, 300)
  }, [])

  const notify = useCallback(
    (opts: Omit<Notification, 'id' | 'timestamp'>): string => {
      // DND mode: suppress non-error notifications
      if (dndMode && opts.type !== 'error') return ''

      const id = nextId()
      const notif: Notification = { ...opts, id, timestamp: Date.now() }
      setNotifications((prev) => {
        const next = [...prev, notif]
        // Trim to MAX_VISIBLE, dismissing oldest first
        if (next.length > MAX_VISIBLE) {
          const toRemove = next.slice(0, next.length - MAX_VISIBLE)
          for (const n of toRemove) dismiss(n.id)
        }
        return next.slice(-MAX_VISIBLE)
      })

      // Auto-dismiss
      const ms = AUTO_DISMISS_MS[opts.type]
      if (ms > 0) {
        const timer = setTimeout(() => dismiss(id), ms)
        timersRef.current.set(id, timer)
      }

      return id
    },
    [dndMode, dismiss],
  )

  const clearAll = useCallback(() => {
    for (const [id, timer] of timersRef.current) {
      clearTimeout(timer)
    }
    timersRef.current.clear()
    setNotifications([])
  }, [])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
    }
  }, [])

  return (
    <NotificationContext.Provider value={{ notifications, notify, dismiss, clearAll, dndMode, setDndMode }}>
      {children}
      <NotificationStack />
    </NotificationContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Notification Stack (renders at bottom-right)
// ---------------------------------------------------------------------------

function NotificationStack() {
  const { notifications, dismiss } = useNotifications()
  const visible = notifications.filter((n) => !n.dismissed)

  if (visible.length === 0) return null

  return (
    <View style={stackStyles.container}>
      {visible.map((notif) => (
        <NotificationCard key={notif.id} notification={notif} onDismiss={() => dismiss(notif.id)} />
      ))}
    </View>
  )
}

function NotificationCard({ notification, onDismiss }: { notification: Notification; onDismiss: () => void }) {
  const { type, title, message, actions } = notification
  const anim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start()
  }, [anim])

  const bgColor = TYPE_COLORS[type]
  const icon = TYPE_ICONS[type]

  return (
    <Animated.View
      style={[
        cardStyles.container,
        { backgroundColor: bgColor, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }, { opacity: anim }] },
      ]}
    >
      <View style={cardStyles.header}>
        <Text style={cardStyles.icon}>{icon}</Text>
        <Text style={cardStyles.title} numberOfLines={1}>
          {title}
        </Text>
        <TouchableOpacity style={cardStyles.closeButton} onPress={onDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={cardStyles.closeText}>×</Text>
        </TouchableOpacity>
      </View>
      {message ? (
        <Text style={cardStyles.message} numberOfLines={3}>
          {message}
        </Text>
      ) : null}
      {actions && actions.length > 0 ? (
        <View style={cardStyles.actions}>
          {actions.map((action, i) => (
            <TouchableOpacity key={i} style={cardStyles.actionButton} onPress={action.onClick}>
              <Text style={cardStyles.actionText}>{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<NotificationType, string> = {
  info: '#1e1e2e',
  success: '#1a3a2a',
  warning: '#3a2a1a',
  error: '#3a1a1a',
}

const TYPE_ICONS: Record<NotificationType, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
}

const stackStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 32,
    right: 16,
    zIndex: 2147483646,
    gap: 8,
    maxWidth: 380,
    width: '100%',
    ...(Platform.OS === 'web' ? {} : {}),
  },
})

const cardStyles = StyleSheet.create({
  container: {
    borderRadius: 8,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  icon: {
    fontSize: 14,
  },
  title: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#e0e0e0',
    fontFamily: Platform.OS === 'web' ? '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' : 'System',
  },
  closeButton: {
    padding: 4,
  },
  closeText: {
    fontSize: 18,
    color: '#888',
    lineHeight: 18,
  },
  message: {
    marginTop: 6,
    fontSize: 12,
    color: '#aaa',
    lineHeight: 16,
    fontFamily: 'monospace',
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  actionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  actionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#e0e0e0',
  },
})
