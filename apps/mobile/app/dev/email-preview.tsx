// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { SafeAreaView } from 'react-native-safe-area-context'
import { EmailPreviewDev } from '@/components/email/EmailPreviewDev'

export default function DevEmailPreview() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <EmailPreviewDev />
    </SafeAreaView>
  )
}
