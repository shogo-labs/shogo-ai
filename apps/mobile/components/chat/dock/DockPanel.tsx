// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared chrome for every chat dock panel: header row (accent dot, icon,
 * title, summary, header actions, dismiss, chevron) plus a fade-in body.
 *
 * Body content mounts/unmounts with `expanded` rather than animating a
 * measured height — matching the majority of the codebase's existing
 * collapsible cards (`ProcessPanel`, `SubagentPanel`, `PlanCard`,
 * `TodoWidget`), and critically, this is what lets a panel like the live
 * browser viewport actually suspend its subscription while collapsed:
 * unmounting is the suspend.
 *
 * Blocking panels render without a chevron and are not collapsible — the
 * store already reports them as always-expanded and refuses to toggle
 * them, but `collapsible={false}` here is a second line of defense against
 * a stray tap collapsing something the agent turn is blocked on.
 *
 * Deliberately chromeless at the panel level (no rounded/border/bg/shadow
 * of its own) — `ChatDock` wraps each zone's stack of panels in ONE
 * rounded card, so nesting a second card here would read as "a card
 * within a card". `isFirst` suppresses the inter-panel divider for the
 * top panel in a zone, since the zone card's own border already closes
 * that edge.
 */

import { useMemo, type ReactNode } from "react"
import { View, Text, Pressable } from "react-native"
import { Motion, AnimatePresence } from "@legendapp/motion"
import { ChevronDown, X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { DockPanelAccent, DockIconComponent } from "../../../lib/chat-dock-store"

const ANIM_DURATION = 220
const ROTATE_TRANSITION = { type: "timing", duration: ANIM_DURATION, easing: "easeInOut" } as const
const ROTATE_OPEN = { rotateZ: "180deg" }
const ROTATE_CLOSED = { rotateZ: "0deg" }
const FADE_TRANSITION = { type: "timing", duration: ANIM_DURATION, easing: "easeInOut" } as const
const FADE_INITIAL = { opacity: 0 }
const FADE_ANIMATE = { opacity: 1 }
const FADE_EXIT = { opacity: 0 }

const ACCENT_DOT_CLASS: Record<DockPanelAccent, string> = {
  default: "bg-muted-foreground/40",
  running: "bg-emerald-400",
  warning: "bg-amber-400",
}

export interface DockPanelProps {
  title: string
  icon: DockIconComponent
  summary?: string
  accent?: DockPanelAccent
  headerActions?: ReactNode
  onDismiss?: () => void
  expanded: boolean
  collapsible: boolean
  onToggle: () => void
  children: ReactNode
  /** Suppresses the top divider — set on the first panel stacked inside a
   *  zone card so it doesn't double up with the card's own top edge. */
  isFirst?: boolean
}

export function DockPanel({
  title,
  icon: Icon,
  summary,
  accent = "default",
  headerActions,
  onDismiss,
  expanded,
  collapsible,
  onToggle,
  children,
  isFirst = false,
}: DockPanelProps) {
  const rotateAnimate = useMemo(() => (expanded ? ROTATE_OPEN : ROTATE_CLOSED), [expanded])

  return (
    <View className={cn("w-full overflow-hidden", !isFirst && "border-t border-border/50")}>
      <Pressable
        onPress={collapsible ? onToggle : undefined}
        disabled={!collapsible}
        className="flex-row items-center gap-2 px-3 py-2"
        role={collapsible ? "button" : undefined}
        accessibilityLabel={title}
      >
        <View className={cn("h-1.5 w-1.5 rounded-full", ACCENT_DOT_CLASS[accent])} />
        <Icon size={13} className="text-muted-foreground" />
        <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {summary ? (
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
        {headerActions}
        {onDismiss && (
          <Pressable onPress={onDismiss} hitSlop={6} accessibilityLabel={`Dismiss ${title}`}>
            <X size={12} className="text-muted-foreground/70" />
          </Pressable>
        )}
        {collapsible && (
          <Motion.View animate={rotateAnimate} transition={ROTATE_TRANSITION}>
            <ChevronDown size={12} className="text-muted-foreground/70" />
          </Motion.View>
        )}
      </Pressable>

      <AnimatePresence>
        {expanded && (
          <Motion.View
            initial={FADE_INITIAL}
            animate={FADE_ANIMATE}
            exit={FADE_EXIT}
            transition={FADE_TRANSITION}
            className="border-t border-border/50 px-3 py-2"
          >
            {children}
          </Motion.View>
        )}
      </AnimatePresence>
    </View>
  )
}
