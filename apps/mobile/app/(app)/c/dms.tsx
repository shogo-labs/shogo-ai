// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The DMs tab on phones: people and agents, one list. */
import { TabScreen } from '../../../components/layout/TabScreenHeader'
import { DmsPanel } from '../../../components/team-chat/panels/DmsPanel'

export default function DirectMessagesScreen() {
  return (
    <TabScreen title="DMs" testID="dms-screen">
      <DmsPanel variant="screen" />
    </TabScreen>
  )
}
