// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Lock Screen card and Dynamic Island for an agent that needs you or is
 * working. Drawn natively by the widget extension from this layout, so the
 * function below must stay self-contained: it can use `@expo/ui` and nothing
 * else from this app.
 */
import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui'
import { activityBackgroundTint, font, foregroundStyle, lineLimit, padding, widgetURL } from '@expo/ui/swift-ui/modifiers'
import type { LiveActivityComponent } from 'expo-widgets'
import type { AgentActivityProps } from './live-activity-plan'

export const AGENT_ACTIVITY_NAME = 'AgentActivity'

const AgentActivity: LiveActivityComponent<AgentActivityProps> = (props) => {
  'widget'
  const waiting = props.state === 'needs_you'
  const accent = waiting ? '#FFA94D' : props.color
  const icon = waiting ? 'hand.raised.fill' : props.state === 'done' ? 'checkmark.circle.fill' : props.state === 'failed' ? 'exclamationmark.triangle.fill' : 'sparkles'
  return {
    banner: (
      <VStack alignment="leading" spacing={6} modifiers={[padding({ horizontal: 16, vertical: 14 }), widgetURL(props.link), activityBackgroundTint('#16171D')]}>
        <HStack spacing={8}>
          <Image systemName={icon} color={accent} size={18} />
          <Text modifiers={[font({ size: 16, weight: 'semibold' }), foregroundStyle('white')]}>{props.agentName}</Text>
          <Spacer />
          <Text modifiers={[font({ size: 13, weight: 'medium' }), foregroundStyle(accent)]}>{props.headline}</Text>
        </HStack>
        <Text modifiers={[font({ size: 14 }), foregroundStyle('#C4C7D4'), lineLimit(2)]}>{props.detail}</Text>
      </VStack>
    ),
    compactLeading: <Image systemName={icon} color={accent} size={14} />,
    compactTrailing: (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(accent)]}>{waiting ? 'OK?' : String(props.working)}</Text>
    ),
    minimal: <Image systemName={icon} color={accent} size={14} />,
    expandedLeading: <Image systemName={icon} color={accent} size={26} />,
    expandedCenter: (
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ size: 16, weight: 'semibold' }), foregroundStyle('white')]}>{props.agentName}</Text>
        <Text modifiers={[font({ size: 13 }), foregroundStyle(accent)]}>{props.headline}</Text>
      </VStack>
    ),
    expandedBottom: <Text modifiers={[font({ size: 14 }), foregroundStyle('#C4C7D4'), lineLimit(2)]}>{props.detail}</Text>,
  }
}

export default AgentActivity
