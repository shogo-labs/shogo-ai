// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The DMs tab on phones: people and agents, one list. */
import { useLocalSearchParams } from 'expo-router'
import { TabScreen } from '../../../components/layout/TabScreenHeader'
import { DmsPanel } from '../../../components/team-chat/panels/DmsPanel'
import type { DmFilter } from '../../../lib/dm-list'

const VALID_FILTERS: DmFilter[] = ['all', 'unreads', 'people', 'agents']

export default function DirectMessagesScreen() {
  const params = useLocalSearchParams<{ filter?: string }>()
  const filter = VALID_FILTERS.includes(params.filter as DmFilter) ? (params.filter as DmFilter) : undefined
  return (
    <TabScreen title="DMs" testID="dms-screen">
      <DmsPanel variant="screen" initialFilter={filter} />
    </TabScreen>
  )
}
