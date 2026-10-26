// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Backup & export.
 *
 * A thin frame around {@link WorkspaceExportSection}: this view owns the page
 * padding and the heading, the section owns the two cards (export + import) so
 * the same section can be dropped into a channel doc or a project panel later.
 */

import { ScrollView, View } from 'react-native'
import { Text } from './account-sheet-chrome'
import { WorkspaceExportSection } from './WorkspaceExportSection'

export function WorkspaceExportView() {
  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ paddingBottom: 48 }}
      showsVerticalScrollIndicator={false}
    >
      <View className="gap-4 px-4 pt-4 sm:px-6">
        <View className="gap-1">
          <Text className="text-xl font-semibold">Backup &amp; export</Text>
          <Text className="text-sm text-muted-foreground">
            Download everything that belongs to this workspace as one archive, or restore one.
          </Text>
        </View>
        <WorkspaceExportSection />
      </View>
    </ScrollView>
  )
}
