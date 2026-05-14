// SPDX-License-Identifier: MIT
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
