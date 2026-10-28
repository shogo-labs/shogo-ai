// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The way out of a pane that sits beside the timeline: the thread header's X,
 * the phone's floating "Back to conversation" button, and the task-thread
 * window's X. One component for all three, so a pane never has a different way
 * out depending on which pane it is.
 *
 * On web the press is taken from the pointer gesture itself, not only from
 * `onPress`. RN-web fires `onPress` from the native `click`, and the browser
 * drops that click when the button's DOM node is replaced or moved between
 * mousedown and mouseup, or when a `selectionchange` terminates the responder
 * mid-gesture — which is what a reply streaming into the pane can cause. The
 * gesture here is judged by where the pointer is released over the button, so
 * it survives both; `onPress` still covers native, and keyboard on web.
 */
import { useCallback, useEffect, useRef } from 'react'
import { Platform, Pressable, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'
import { WebTooltip } from './WebTooltip'
import { CHROME_SIZE } from '../team-chat/FloatingChrome'

export interface PaneCloseButtonProps {
  /** Accessible name, e.g. "Close thread". Also the web tooltip's text. */
  label: string
  onClose: () => void
  /** `plain` is the small X in a header; `glass` is the round floating button. */
  variant?: 'plain' | 'glass'
  /** The icon to paint inside the button. */
  children: React.ReactNode
  className?: string
  hitSlop?: number
}

/** Presses closer together than this are one press, not two. */
const DEDUPE_MS = 500
/** A release this far outside the button still counts, matching `hitSlop`. */
const SLOP_PX = 8

/**
 * Close on a pointer press that starts and ends on the button, whatever the
 * synthetic `click` did. No-op off web, where `onPress` is the whole story.
 */
function useWebPressFallback(
  ref: React.RefObject<View | null>,
  fire: () => void,
  slop: number,
): void {
  const fireRef = useRef(fire)
  fireRef.current = fire
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const node = ref.current as unknown as HTMLElement | null
    if (!node?.addEventListener) return
    let down = false
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      down = true
    }
    const onUp = (event: PointerEvent) => {
      if (!down) return
      down = false
      // The button as it is now: a re-render may have replaced the node under
      // the pointer, and the release is still a press on the button.
      const target = ref.current as unknown as HTMLElement | null
      const box = target?.getBoundingClientRect?.()
      if (!box) return
      const inside =
        event.clientX >= box.left - slop &&
        event.clientX <= box.right + slop &&
        event.clientY >= box.top - slop &&
        event.clientY <= box.bottom + slop
      if (inside) fireRef.current()
    }
    const onCancel = () => {
      down = false
    }
    node.addEventListener('pointerdown', onDown)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
    return () => {
      node.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onCancel, true)
    }
  }, [ref, slop])
}

export function PaneCloseButton({
  label,
  onClose,
  variant = 'plain',
  children,
  className,
  hitSlop,
}: PaneCloseButtonProps) {
  const ref = useRef<View>(null)
  const firedAt = useRef(0)
  const fire = useCallback(() => {
    const now = Date.now()
    if (now - firedAt.current < DEDUPE_MS) return
    firedAt.current = now
    onClose()
  }, [onClose])
  useWebPressFallback(ref, fire, hitSlop ?? SLOP_PX)

  if (variant === 'glass') {
    return (
      <Pressable
        ref={ref}
        onPress={fire}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="items-center justify-center overflow-hidden rounded-full bg-transparent shadow-sm active:opacity-70"
        style={{ width: CHROME_SIZE, height: CHROME_SIZE }}
      >
        <LiquidGlassBackdrop style={{ borderRadius: CHROME_SIZE / 2 }} />
        <View className="items-center justify-center">
          <WebTooltip label={label}>{children}</WebTooltip>
        </View>
      </Pressable>
    )
  }

  return (
    <Pressable
      ref={ref}
      onPress={fire}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn('rounded-md p-1.5 active:bg-muted hover:bg-muted', className)}
    >
      {children}
    </Pressable>
  )
}
