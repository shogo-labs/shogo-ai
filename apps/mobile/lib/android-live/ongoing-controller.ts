// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { AgentGlanceSnapshot } from '../agent-glance'
import type { GlanceSink } from '../glance-publisher'
import { ongoingChanged, planOngoingNotification, type OngoingContent } from './ongoing-plan'

export interface OngoingNotifier {
  present(content: OngoingContent): Promise<void> | void
  clear(): Promise<void> | void
}

/** Keeps the ongoing notification in step with the snapshot, posting only on change. */
export function createOngoingSink(notifier: OngoingNotifier, now: () => number = Date.now): GlanceSink {
  let shown: OngoingContent | null = null
  return async (snapshot: AgentGlanceSnapshot) => {
    const plan = planOngoingNotification(snapshot, now())
    if (plan.kind === 'clear') {
      if (!shown) return
      shown = null
      await notifier.clear()
      return
    }
    if (!ongoingChanged(shown, plan.content)) return
    shown = plan.content
    await notifier.present(plan.content)
  }
}
