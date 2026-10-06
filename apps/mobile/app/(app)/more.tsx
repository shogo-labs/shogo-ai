// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The More tab on phones: the few places that do not have a tab of their own. */
import { TabScreen, TabScreenScrollView } from '../../components/layout/TabScreenHeader'
import { MorePanel } from '../../components/layout/sidebar/TabPanels'

export default function MoreScreen() {
  return (
    <TabScreen title="More" testID="more-screen">
      <TabScreenScrollView contentContainerClassName="pb-36">
        <MorePanel variant="screen" />
      </TabScreenScrollView>
    </TabScreen>
  )
}
