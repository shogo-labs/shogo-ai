// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View } from 'react-native'
import { Hammer, MessageCircleHeart, Users } from 'lucide-react-native'
import { SelectableCard } from '../SelectableCard'

export type Destination = 'personal' | 'team' | 'joined'

interface DestinationStepProps {
  value: Destination | null
  onChange: (value: Destination) => void
  /** Name of a team workspace the user was invited into, if any. */
  joinedWorkspaceName?: string
}

export function DestinationStep({ value, onChange, joinedWorkspaceName }: DestinationStepProps) {
  return (
    <View className="gap-3" accessibilityRole="radiogroup">
      {joinedWorkspaceName ? (
        <SelectableCard
          testID="onboarding-destination-joined"
          icon={Users}
          title={joinedWorkspaceName}
          badge="Invited"
          description="The team workspace you were invited to. This is where your team builds things."
          selected={value === 'joined'}
          onPress={() => onChange('joined')}
        />
      ) : null}
      <View className="flex-col gap-3 sm:flex-row">
        <SelectableCard
          testID="onboarding-destination-personal"
          icon={MessageCircleHeart}
          title="My Personal space"
          description="A private companion that remembers your context and turns it into goals and tasks."
          selected={value === 'personal'}
          onPress={() => onChange('personal')}
        />
        <SelectableCard
          testID="onboarding-destination-team"
          icon={Hammer}
          title="My Team workspace"
          description="Where you build things: create projects and agents, install agents from the marketplace, connect integrations, and bring in teammates."
          selected={value === 'team'}
          onPress={() => onChange('team')}
        />
      </View>
    </View>
  )
}
