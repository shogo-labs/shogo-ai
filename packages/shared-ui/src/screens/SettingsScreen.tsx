/**
 * Shared SettingsScreen — universal (React Native + NativeWind)
 */

import React from 'react'
import { View, Text, ScrollView } from 'react-native'
import { Card, CardContent } from '../primitives/Card'
import { Button } from '../primitives/Button'
import { Separator } from '../primitives/Separator'

export interface SettingsScreenProps {
  userName?: string | null
  userEmail?: string | null
  workspaceName?: string | null
  memberCount?: number
  onSignOut: () => void
}

export function SettingsScreen({
  userName,
  userEmail,
  workspaceName,
  memberCount,
  onSignOut,
}: SettingsScreenProps) {
  return (
    <ScrollView className="flex-1 bg-background">
      <View className="px-6 pt-6 pb-4">
        <Text className="text-2xl font-bold text-foreground">Settings</Text>
      </View>

      <View className="px-6">
        <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Account
        </Text>
        <Card>
          <CardContent className="p-0">
            <View className="px-4 py-3">
              <Text className="text-sm text-muted-foreground">Name</Text>
              <Text className="text-foreground font-medium">{userName ?? '—'}</Text>
            </View>
            <Separator />
            <View className="px-4 py-3">
              <Text className="text-sm text-muted-foreground">Email</Text>
              <Text className="text-foreground font-medium">{userEmail ?? '—'}</Text>
            </View>
          </CardContent>
        </Card>
      </View>

      {workspaceName ? (
        <View className="px-6 mt-6">
          <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Workspace
          </Text>
          <Card>
            <CardContent className="p-0">
              <View className="px-4 py-3">
                <Text className="text-sm text-muted-foreground">Workspace Name</Text>
                <Text className="text-foreground font-medium">{workspaceName}</Text>
              </View>
              {memberCount !== undefined ? (
                <>
                  <Separator />
                  <View className="px-4 py-3">
                    <Text className="text-sm text-muted-foreground">Members</Text>
                    <Text className="text-foreground font-medium">{memberCount}</Text>
                  </View>
                </>
              ) : null}
            </CardContent>
          </Card>
        </View>
      ) : null}

      <View className="px-6 mt-8 mb-8">
        <Button variant="destructive" onPress={onSignOut} className="w-full">
          Sign Out
        </Button>
      </View>
    </ScrollView>
  )
}
