// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Text, View } from 'react-native'
import { Hammer, MessageCircleHeart, Users } from 'lucide-react-native'

const ROLE_LABELS: Record<string, string> = {
  owner: 'an Owner',
  admin: 'an Admin',
  member: 'an Editor',
  viewer: 'a Viewer',
}

interface JoinedStepProps {
  workspaceName: string
  role?: string
}

export function JoinedStep({ workspaceName, role }: JoinedStepProps) {
  const rows = [
    {
      icon: Users,
      title: workspaceName,
      description: `You're ${(role && ROLE_LABELS[role]) || 'a member'} here. This is where your team builds things.`,
    },
    {
      icon: MessageCircleHeart,
      title: 'Your Personal space',
      description: 'A private companion just for you.',
    },
    {
      icon: Hammer,
      title: 'Your own Team workspace',
      description: 'For building your own projects and agents.',
    },
  ]
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card">
      {rows.map((row, i) => (
        <View
          key={row.title}
          className={`flex-row items-start gap-4 p-5 ${i > 0 ? 'border-t border-border' : ''}`}
        >
          <View className="h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <row.icon size={20} className="text-primary" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-semibold text-foreground">{row.title}</Text>
            <Text className="mt-1 text-sm leading-5 text-muted-foreground">{row.description}</Text>
          </View>
        </View>
      ))}
    </View>
  )
}
