// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Android Home Screen widget: what is waiting on you, what is working.
 * Tapping a row opens `shogo://agents/<id>`; tapping the header opens the app.
 */
import React from 'react'
import { FlexWidget, TextWidget } from 'react-native-android-widget'
import type { AgentGlanceSnapshot, GlanceAgent } from '../agent-glance'
import { glanceAgentSubtitle, glanceAgents, glanceHeadline } from '../glance-summary'

export const ANDROID_WIDGET_NAME = 'ShogoAgents'
const MAX_ROWS = 3
const PANEL = '#16171D'
const WAITING = '#FFA94D'

function Row({ agent }: { agent: GlanceAgent }) {
  return (
    <FlexWidget
      style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', paddingVertical: 4 }}
      clickAction="OPEN_URI"
      clickActionData={{ uri: agent.link }}
    >
      <FlexWidget style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: agent.color as `#${string}`, marginRight: 8 }} />
      <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
        <TextWidget text={agent.name} maxLines={1} truncate="END" style={{ fontSize: 14, fontWeight: 'bold', color: '#FFFFFF' }} />
        <TextWidget
          text={glanceAgentSubtitle(agent)}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 12, color: agent.state === 'needs_you' ? WAITING : '#A8ABB8' }}
        />
      </FlexWidget>
    </FlexWidget>
  )
}

export function AgentsWidget({ snapshot, now }: { snapshot: AgentGlanceSnapshot | null; now: number }) {
  const agents = glanceAgents(snapshot, now, MAX_ROWS)
  return (
    <FlexWidget
      style={{ flexDirection: 'column', width: 'match_parent', height: 'match_parent', backgroundColor: PANEL, borderRadius: 22, padding: 14 }}
      clickAction="OPEN_APP"
    >
      <TextWidget text={glanceHeadline(snapshot, now)} style={{ fontSize: 18, fontWeight: 'bold', color: '#FFFFFF' }} />
      {agents.length === 0 ? (
        <TextWidget text="Your agents appear here" style={{ fontSize: 12, color: '#A8ABB8' }} />
      ) : (
        agents.map((agent) => <Row key={agent.id} agent={agent} />)
      )}
    </FlexWidget>
  )
}
