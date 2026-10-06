// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Carries out `planLiveActivity` against the native Live Activity. The native
 * side is passed in, so this runs in tests without ActivityKit.
 */
import type { AgentGlanceSnapshot } from '../agent-glance'
import type { GlanceSink } from '../glance-publisher'
import { planLiveActivity, type AgentActivityProps } from './live-activity-plan'

export interface LiveActivityApi {
  /** An activity is on screen now (it may have been started by an earlier launch or by the server). */
  isRunning(): boolean
  start(props: AgentActivityProps): Promise<void> | void
  update(props: AgentActivityProps): Promise<void> | void
  end(props: AgentActivityProps | null): Promise<void> | void
}

export function createLiveActivitySink(api: LiveActivityApi, now: () => number = Date.now): GlanceSink {
  let last: AgentActivityProps | null = null
  return async (snapshot: AgentGlanceSnapshot) => {
    const action = planLiveActivity({ snapshot, running: api.isRunning(), now: now(), last })
    switch (action.kind) {
      case 'start':
        await api.start(action.props)
        last = action.props
        break
      case 'update':
        await api.update(action.props)
        last = action.props
        break
      case 'end':
        last = null
        await api.end(action.props)
        break
      case 'none':
        break
    }
  }
}
